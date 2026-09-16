import express, { type Request, type Response, type Router } from "express";
import { DcrRegistrationError, type DcrService } from "./service.js";

export interface DcrRouterOptions {
  dcrService: DcrService;
}

function setNoStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

function isJsonContentType(req: Request): boolean {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string") return false;
  return /^application\/json(?:\s*;|$)/i.test(contentType);
}

export function createDcrRouter(options: DcrRouterOptions): Router {
  const { dcrService } = options;
  const router = express.Router();

  router.post("/register", (req: Request, res: Response) => {
    setNoStore(res);

    if (!isJsonContentType(req)) {
      res.status(415).json({
        error: "invalid_client_metadata",
        error_description: "Content-Type must be application/json",
      });
      return;
    }

    try {
      const registered = dcrService.register(req.body);
      res.status(201).json(registered);
    } catch (err) {
      if (err instanceof DcrRegistrationError) {
        res.status(err.statusCode).json({
          error: err.errorCode,
          error_description: err.errorDescription,
        });
        return;
      }
      process.stderr.write(`oauth-dcr: unexpected registration error: ${err instanceof Error ? err.stack : err}\n`);
      res.status(500).json({
        error: "server_error",
        error_description: "Internal server error",
      });
    }
  });

  return router;
}
