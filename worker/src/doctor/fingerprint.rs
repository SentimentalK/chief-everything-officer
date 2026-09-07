use crate::config::WorkerConfig;
use crate::executor::adapter_trait::LaunchConfiguration;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub exists: bool,
    pub is_symlink: bool,
    pub symlink_target: Option<String>,
    pub content_sha256: Option<String>,
    pub read_error: Option<String>,
}

impl FileEntry {
    pub fn from_path(path: &Path, is_json: bool) -> Self {
        let path_str = path.to_string_lossy().to_string();
        let symlink_meta = fs::symlink_metadata(path);
        if symlink_meta.is_err() {
            return Self {
                path: path_str,
                exists: false,
                is_symlink: false,
                symlink_target: None,
                content_sha256: None,
                read_error: None,
            };
        }

        let is_symlink = symlink_meta
            .as_ref()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        let symlink_target = if is_symlink {
            fs::read_link(path)
                .ok()
                .map(|t| t.to_string_lossy().to_string())
        } else {
            None
        };

        match fs::read(path) {
            Ok(bytes) => {
                let sha256_hex =
                    if bytes.is_empty() || bytes.iter().all(|b| b.is_ascii_whitespace()) {
                        let mut hasher = Sha256::new();
                        hasher.update(&bytes);
                        format!("{:x}", hasher.finalize())
                    } else if is_json {
                        match serde_json::from_slice::<serde_json::Value>(&bytes) {
                            Ok(val) => {
                                let canonical = canonicalize_json(&val);
                                let canonical_bytes =
                                    serde_json::to_string(&canonical).unwrap_or_default();
                                let mut hasher = Sha256::new();
                                hasher.update(canonical_bytes.as_bytes());
                                format!("{:x}", hasher.finalize())
                            }
                            Err(e) => {
                                return Self {
                                    path: path_str,
                                    exists: true,
                                    is_symlink,
                                    symlink_target,
                                    content_sha256: None,
                                    read_error: Some(format!("Invalid JSON: {}", e)),
                                };
                            }
                        }
                    } else {
                        let mut hasher = Sha256::new();
                        hasher.update(&bytes);
                        format!("{:x}", hasher.finalize())
                    };

                Self {
                    path: path_str,
                    exists: true,
                    is_symlink,
                    symlink_target,
                    content_sha256: Some(sha256_hex),
                    read_error: None,
                }
            }
            Err(e) => Self {
                path: path_str,
                exists: true,
                is_symlink,
                symlink_target,
                content_sha256: None,
                read_error: Some(e.to_string()),
            },
        }
    }
}

pub fn canonicalize_json(val: &serde_json::Value) -> serde_json::Value {
    match val {
        serde_json::Value::Object(map) => {
            let mut sorted = BTreeMap::new();
            for (k, v) in map {
                sorted.insert(k.clone(), canonicalize_json(v));
            }
            serde_json::to_value(sorted).unwrap_or_else(|_| serde_json::Value::Object(map.clone()))
        }
        serde_json::Value::Array(arr) => {
            let sorted: Vec<_> = arr.iter().map(canonicalize_json).collect();
            serde_json::Value::Array(sorted)
        }
        other => other.clone(),
    }
}

pub fn scan_markdown_files_recursive(base_dir: &Path) -> Vec<FileEntry> {
    let mut entries = Vec::new();
    if !base_dir.exists() || !base_dir.is_dir() {
        return entries;
    }

    let mut stack = vec![base_dir.to_path_buf()];
    let mut md_paths = Vec::new();

    while let Some(dir) = stack.pop() {
        if let Ok(read_dir) = fs::read_dir(&dir) {
            for entry in read_dir.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.is_file() {
                    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                        if ext.eq_ignore_ascii_case("md") {
                            md_paths.push(path);
                        }
                    }
                }
            }
        }
    }

    md_paths.sort();
    for p in md_paths {
        entries.push(FileEntry::from_path(&p, false));
    }
    entries
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginFingerprint {
    pub plugins_dir_exists: bool,
    pub enabled_plugins: Vec<String>,
    pub files: Vec<FileEntry>,
    pub can_determine_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HookFingerprint {
    pub configured_hooks: Vec<String>,
    pub script_files: Vec<FileEntry>,
    pub all_scripts_resolvable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutorFingerprint {
    pub binary_path: Option<String>,
    pub version: String,
    pub binary_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IdentitySystemFingerprint {
    pub uid: u32,
    pub gid: u32,
    pub groups: Vec<u32>,
    pub arch: String,
    pub kernel_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeEnvFingerprint {
    pub shell: String,
    pub path: String,
    pub tmpdir_root: String,
    pub xdg_config_home: String,
    pub xdg_cache_home: String,
    pub xdg_data_home: String,
    pub xdg_state_home: String,
    pub tmp_var: String,
    pub temp_var: String,
    pub proxy_http: String,
    pub proxy_https: String,
    pub proxy_all: String,
    pub proxy_no: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerLogicFingerprint {
    pub worker_binary_sha256: String,
    pub doctor_prompt_template_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FingerprintComponents {
    pub cli_settings: FileEntry,
    pub global_rules: Vec<FileEntry>,
    pub workspace_rules: Vec<FileEntry>,
    pub guide_files: Vec<FileEntry>,
    pub mcp_configs: Vec<FileEntry>,
    pub skills: Vec<FileEntry>,
    pub plugins: PluginFingerprint,
    pub hooks: HookFingerprint,
    pub conservative_watch_items: Vec<FileEntry>,
    pub executor: ExecutorFingerprint,
    pub launch_config: LaunchConfiguration,
    pub workspace_canonical: String,
    pub worker_logic: WorkerLogicFingerprint,
    pub identity_system: IdentitySystemFingerprint,
    pub runtime_env: RuntimeEnvFingerprint,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentFingerprint {
    pub fingerprint_hash: String,
    pub cache_eligible: bool,
    pub ineligibility_reason: Option<String>,
    pub components: FingerprintComponents,
}

pub struct FingerprintBuilder;

impl FingerprintBuilder {
    pub fn build(
        workspace: &Path,
        config: &WorkerConfig,
        launch_config: &LaunchConfiguration,
        doctor_prompt_template: &str,
    ) -> EnvironmentFingerprint {
        let home_dir = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
        let home = Path::new(&home_dir);
        let gemini_cli_dir = home.join(".gemini").join("antigravity-cli");
        let gemini_config_dir = home.join(".gemini").join("config");

        let mut cache_eligible = true;
        let mut ineligibility_reasons = Vec::new();

        // 1. CLI settings: ~/.gemini/antigravity-cli/settings.json
        let settings_path = gemini_cli_dir.join("settings.json");
        let cli_settings = FileEntry::from_path(&settings_path, true);
        if cli_settings.read_error.is_some() {
            cache_eligible = false;
            ineligibility_reasons.push(format!(
                "Cannot read CLI settings: {:?}",
                cli_settings.read_error
            ));
        }

        // 2. Global rules: ~/.gemini/GEMINI.md, ~/.gemini/config/AGENTS.md, ~/.gemini/config/GEMINI.md
        let mut global_rules = Vec::new();
        for p in &[
            home.join(".gemini").join("GEMINI.md"),
            gemini_config_dir.join("AGENTS.md"),
            gemini_config_dir.join("GEMINI.md"),
        ] {
            let entry = FileEntry::from_path(p, false);
            if entry.read_error.is_some() {
                cache_eligible = false;
                ineligibility_reasons.push(format!(
                    "Cannot read global rule file {}: {:?}",
                    p.display(),
                    entry.read_error
                ));
            }
            global_rules.push(entry);
        }

        // 3. Workspace rules: <workspace>/AGENTS.md, <workspace>/GEMINI.md
        let mut workspace_rules = Vec::new();
        for p in &[workspace.join("AGENTS.md"), workspace.join("GEMINI.md")] {
            let entry = FileEntry::from_path(p, false);
            if entry.read_error.is_some() {
                cache_eligible = false;
                ineligibility_reasons.push(format!(
                    "Cannot read workspace rule file {}: {:?}",
                    p.display(),
                    entry.read_error
                ));
            }
            workspace_rules.push(entry);
        }

        // 4. Guide files from config
        let mut guide_files = Vec::new();
        let mut guide_list = config.guide_files.clone();
        let default_guide = workspace.join("AGENT_GUIDE.md");
        if default_guide.exists() && !guide_list.contains(&default_guide) {
            guide_list.push(default_guide);
        }
        guide_list.sort();
        for p in guide_list {
            let full_p = if p.is_absolute() {
                p
            } else {
                workspace.join(p)
            };
            let entry = FileEntry::from_path(&full_p, false);
            if entry.read_error.is_some() {
                cache_eligible = false;
                ineligibility_reasons.push(format!(
                    "Cannot read guide file {}: {:?}",
                    full_p.display(),
                    entry.read_error
                ));
            }
            guide_files.push(entry);
        }

        // 5. MCP configs: ~/.gemini/config/mcp_config.json, <workspace>/.agents/mcp_config.json
        let mut mcp_configs = Vec::new();
        for p in &[
            gemini_config_dir.join("mcp_config.json"),
            workspace.join(".agents").join("mcp_config.json"),
        ] {
            let entry = FileEntry::from_path(p, true);
            if entry.read_error.is_some() {
                cache_eligible = false;
                ineligibility_reasons.push(format!(
                    "Cannot read MCP config {}: {:?}",
                    p.display(),
                    entry.read_error
                ));
            }
            mcp_configs.push(entry);
        }

        // 6. Skills: recursive Markdown collection
        let mut skills = Vec::new();
        let ws_skills_dir = workspace.join(".agents").join("skills");
        skills.extend(scan_markdown_files_recursive(&ws_skills_dir));
        let global_skills_dir = gemini_cli_dir.join("skills");
        skills.extend(scan_markdown_files_recursive(&global_skills_dir));
        for s in &skills {
            if s.read_error.is_some() {
                cache_eligible = false;
                ineligibility_reasons.push(format!(
                    "Cannot read skill file {}: {:?}",
                    s.path, s.read_error
                ));
            }
        }

        // 7. Plugins
        let plugins_dir = gemini_cli_dir.join("plugins");
        let mut plugin_files = Vec::new();
        let mut enabled_plugins = Vec::new();
        let plugins_dir_exists = plugins_dir.exists() && plugins_dir.is_dir();
        let mut can_determine_enabled = true;

        if plugins_dir_exists {
            // Check if settings.json defines enabled plugins
            let mut found_enabled_in_settings = false;
            if cli_settings.exists && cli_settings.read_error.is_none() {
                if let Ok(content) = fs::read_to_string(&settings_path) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                        if let Some(plugins_val) = val.get("plugins") {
                            if let Some(arr) = plugins_val.get("enabled").and_then(|v| v.as_array())
                            {
                                found_enabled_in_settings = true;
                                for p in arr {
                                    if let Some(name) = p.as_str() {
                                        enabled_plugins.push(name.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if found_enabled_in_settings {
                for plugin_name in &enabled_plugins {
                    let pdir = plugins_dir.join(plugin_name);
                    if pdir.exists() {
                        for sub_f in &[
                            pdir.join("manifest.json"),
                            pdir.join("mcp.json"),
                            pdir.join("hooks.json"),
                        ] {
                            if sub_f.exists() {
                                plugin_files.push(FileEntry::from_path(
                                    sub_f,
                                    sub_f.extension().is_some_and(|e| e == "json"),
                                ));
                            }
                        }
                        plugin_files.extend(scan_markdown_files_recursive(&pdir.join("rules")));
                        plugin_files.extend(scan_markdown_files_recursive(&pdir.join("skills")));
                    }
                }
            } else {
                // If plugins dir exists with subdirectories but no enablement setting can be identified
                let subdirs: Vec<_> = fs::read_dir(&plugins_dir)
                    .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).collect())
                    .unwrap_or_default();
                if !subdirs.is_empty() {
                    can_determine_enabled = false;
                    cache_eligible = false;
                    ineligibility_reasons.push("Plugins directory exists with plugins, but enabled plugins set cannot be determined".to_string());
                }
            }
        }

        let plugins = PluginFingerprint {
            plugins_dir_exists,
            enabled_plugins,
            files: plugin_files,
            can_determine_enabled,
        };

        // 8. Hooks
        let mut configured_hooks = Vec::new();
        let mut script_files = Vec::new();
        let mut all_scripts_resolvable = true;
        let hooks_config_path = gemini_cli_dir.join("hooks.json");
        if hooks_config_path.exists() {
            if let Ok(content) = fs::read_to_string(&hooks_config_path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(hooks_map) = val.as_object() {
                        for (hook_name, hook_val) in hooks_map {
                            configured_hooks.push(hook_name.clone());
                            if let Some(cmd_str) = hook_val
                                .get("command")
                                .or_else(|| hook_val.get("script"))
                                .and_then(|v| v.as_str())
                            {
                                let script_p = PathBuf::from(cmd_str);
                                if script_p.exists() {
                                    script_files.push(FileEntry::from_path(&script_p, false));
                                } else {
                                    all_scripts_resolvable = false;
                                    cache_eligible = false;
                                    ineligibility_reasons.push(format!(
                                        "Hook script for {} cannot be resolved at {:?}",
                                        hook_name, cmd_str
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }

        let hooks = HookFingerprint {
            configured_hooks,
            script_files,
            all_scripts_resolvable,
        };

        // 9. Conservative watch items
        let mut conservative_watch_items = Vec::new();
        conservative_watch_items.push(FileEntry::from_path(
            &gemini_config_dir.join("config.json"),
            true,
        ));
        let project_file = gemini_config_dir
            .join("projects")
            .join(format!("{}.json", launch_config.project_id));
        conservative_watch_items.push(FileEntry::from_path(&project_file, true));
        conservative_watch_items.extend(scan_markdown_files_recursive(
            &gemini_config_dir.join("rules"),
        ));
        for item in &conservative_watch_items {
            if item.read_error.is_some() {
                cache_eligible = false;
                ineligibility_reasons.push(format!(
                    "Cannot read conservative watch item {}: {:?}",
                    item.path, item.read_error
                ));
            }
        }

        // 10. Executor
        let binary_path_str = launch_config
            .executable_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());
        let (version_str, bin_sha256) = if let Some(ref bp) = launch_config.executable_path {
            let ver = if let Some(ref v) = launch_config.version {
                v.clone()
            } else {
                std::process::Command::new(bp)
                    .arg("--version")
                    .output()
                    .ok()
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            };
            let sha = fs::read(bp).ok().map(|bytes| {
                let mut h = Sha256::new();
                h.update(&bytes);
                format!("{:x}", h.finalize())
            });
            (ver, sha)
        } else {
            (
                launch_config
                    .version
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string()),
                None,
            )
        };

        let executor = ExecutorFingerprint {
            binary_path: binary_path_str,
            version: version_str,
            binary_sha256: bin_sha256,
        };

        // 11. Workspace canonical path
        let workspace_canonical = workspace
            .canonicalize()
            .unwrap_or_else(|_| workspace.to_path_buf())
            .to_string_lossy()
            .to_string();

        // 12. Worker logic fingerprint
        static CURRENT_EXE_SHA: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        let current_exe_sha256 = CURRENT_EXE_SHA
            .get_or_init(|| {
                if let Ok(p) = std::env::current_exe() {
                    if let Ok(mut f) = std::fs::File::open(&p) {
                        use std::io::Read;
                        let mut h = Sha256::new();
                        let mut buf = [0u8; 64 * 1024];
                        while let Ok(n) = f.read(&mut buf) {
                            if n == 0 {
                                break;
                            }
                            h.update(&buf[..n]);
                        }
                        return format!("{:x}", h.finalize());
                    }
                }
                "unknown-exe-sha".to_string()
            })
            .clone();

        let mut prompt_hasher = Sha256::new();
        prompt_hasher.update(doctor_prompt_template.as_bytes());
        let doctor_prompt_template_sha256 = format!("{:x}", prompt_hasher.finalize());

        let worker_logic = WorkerLogicFingerprint {
            worker_binary_sha256: current_exe_sha256,
            doctor_prompt_template_sha256,
        };

        // 13. Identity and system
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let mut groups = vec![0u32; 64];
        let ngroups = unsafe { libc::getgroups(groups.len() as i32, groups.as_mut_ptr()) };
        let groups_vec = if ngroups > 0 {
            groups.truncate(ngroups as usize);
            groups
        } else {
            Vec::new()
        };

        let kernel_version = fs::read_to_string("/proc/sys/kernel/osrelease")
            .unwrap_or_else(|_| "unknown-kernel".to_string())
            .trim()
            .to_string();

        let identity_system = IdentitySystemFingerprint {
            uid,
            gid,
            groups: groups_vec,
            arch: std::env::consts::ARCH.to_string(),
            kernel_version,
        };

        // 14. Runtime Environment
        let get_env_or_unset = |k: &str| std::env::var(k).unwrap_or_else(|_| "UNSET".to_string());
        let runtime_env = RuntimeEnvFingerprint {
            shell: get_env_or_unset("SHELL"),
            path: get_env_or_unset("PATH"),
            tmpdir_root: launch_config.tmpdir_root_rule.clone(),
            xdg_config_home: get_env_or_unset("XDG_CONFIG_HOME"),
            xdg_cache_home: get_env_or_unset("XDG_CACHE_HOME"),
            xdg_data_home: get_env_or_unset("XDG_DATA_HOME"),
            xdg_state_home: get_env_or_unset("XDG_STATE_HOME"),
            tmp_var: get_env_or_unset("TMP"),
            temp_var: get_env_or_unset("TEMP"),
            proxy_http: get_env_or_unset("HTTP_PROXY"),
            proxy_https: get_env_or_unset("HTTPS_PROXY"),
            proxy_all: get_env_or_unset("ALL_PROXY"),
            proxy_no: get_env_or_unset("NO_PROXY"),
        };

        let components = FingerprintComponents {
            cli_settings,
            global_rules,
            workspace_rules,
            guide_files,
            mcp_configs,
            skills,
            plugins,
            hooks,
            conservative_watch_items,
            executor,
            launch_config: launch_config.clone(),
            workspace_canonical,
            worker_logic,
            identity_system,
            runtime_env,
        };

        // Compute overall fingerprint hash from canonicalized JSON serialization
        let components_json = serde_json::to_value(&components).unwrap_or(serde_json::Value::Null);
        let canonical_components = canonicalize_json(&components_json);
        let canonical_str = serde_json::to_string(&canonical_components).unwrap_or_default();

        let mut overall_hasher = Sha256::new();
        overall_hasher.update(canonical_str.as_bytes());
        let fingerprint_hash = format!("{:x}", overall_hasher.finalize());

        let ineligibility_reason = if !cache_eligible {
            Some(ineligibility_reasons.join("; "))
        } else {
            None
        };

        EnvironmentFingerprint {
            fingerprint_hash,
            cache_eligible,
            ineligibility_reason,
            components,
        }
    }
}
