use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

pub type RequestHandler = Arc<dyn Fn(&MockRequest) -> MockResponse + Send + Sync>;

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct MockRequest {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl MockRequest {
    pub fn json<T: serde::de::DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_slice(&self.body)
    }
}

#[derive(Debug, Clone)]
pub struct MockResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl MockResponse {
    pub fn json(status: u16, value: &serde_json::Value) -> Self {
        let body = serde_json::to_vec(value).unwrap();
        Self {
            status,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body,
        }
    }
}

#[allow(dead_code)]
pub struct MockServer {
    addr: SocketAddr,
    handlers: Arc<Mutex<Vec<RequestHandler>>>,
    recorded_requests: Arc<Mutex<Vec<MockRequest>>>,
    _handle: JoinHandle<()>,
}

#[allow(dead_code)]
impl MockServer {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handlers = Arc::new(Mutex::new(Vec::<RequestHandler>::new()));
        let recorded_requests = Arc::new(Mutex::new(Vec::<MockRequest>::new()));

        let handlers_clone = handlers.clone();
        let requests_clone = recorded_requests.clone();

        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };

                let handlers = handlers_clone.clone();
                let requests = requests_clone.clone();

                tokio::spawn(async move {
                    let mut buf = vec![0u8; 32768];
                    let mut total_read = 0;

                    // Read initial headers
                    let Ok(n) = socket.read(&mut buf[total_read..]).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    total_read += n;

                    // Simple HTTP parser
                    let header_end = buf[..total_read].windows(4).position(|w| w == b"\r\n\r\n");

                    let Some(end_idx) = header_end else {
                        return;
                    };

                    let header_str = String::from_utf8_lossy(&buf[..end_idx]);
                    let mut lines = header_str.lines();
                    let first_line = lines.next().unwrap_or("");
                    let mut parts = first_line.split_whitespace();
                    let method = parts.next().unwrap_or("GET").to_string();
                    let path = parts.next().unwrap_or("/").to_string();

                    let mut headers = HashMap::new();
                    let mut content_length: usize = 0;

                    for line in lines {
                        if let Some((k, v)) = line.split_once(':') {
                            let key = k.trim().to_lowercase();
                            let val = v.trim().to_string();
                            if key == "content-length" {
                                content_length = val.parse().unwrap_or(0);
                            }
                            headers.insert(key, val);
                        }
                    }

                    let body_start = end_idx + 4;
                    let mut body = buf[body_start..total_read].to_vec();

                    while body.len() < content_length {
                        let mut chunk = vec![0u8; content_length - body.len()];
                        let Ok(n) = socket.read(&mut chunk).await else {
                            break;
                        };
                        if n == 0 {
                            break;
                        }
                        body.extend_from_slice(&chunk[..n]);
                    }

                    let req = MockRequest {
                        method,
                        path,
                        headers,
                        body,
                    };

                    requests.lock().unwrap().push(req.clone());

                    let resp = {
                        let h_guard = handlers.lock().unwrap();
                        let mut response = None;
                        for h in h_guard.iter().rev() {
                            let r = h(&req);
                            if r.status != 0 {
                                response = Some(r);
                                break;
                            }
                        }
                        response.unwrap_or_else(|| MockResponse {
                            status: 404,
                            headers: vec![],
                            body: b"Not Found".to_vec(),
                        })
                    };

                    let status_line = format!("HTTP/1.1 {} OK\r\n", resp.status);
                    let mut resp_bytes = status_line.into_bytes();
                    for (k, v) in resp.headers {
                        resp_bytes.extend_from_slice(format!("{}: {}\r\n", k, v).as_bytes());
                    }
                    resp_bytes.extend_from_slice(
                        format!("Content-Length: {}\r\n\r\n", resp.body.len()).as_bytes(),
                    );
                    resp_bytes.extend_from_slice(&resp.body);

                    let _ = socket.write_all(&resp_bytes).await;
                });
            }
        });

        Self {
            addr,
            handlers,
            recorded_requests,
            _handle: handle,
        }
    }

    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.addr.port())
    }

    pub fn add_handler<F>(&self, handler: F)
    where
        F: Fn(&MockRequest) -> MockResponse + Send + Sync + 'static,
    {
        self.handlers.lock().unwrap().push(Arc::new(handler));
    }

    pub fn requests(&self) -> Vec<MockRequest> {
        self.recorded_requests.lock().unwrap().clone()
    }
}
