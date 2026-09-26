import { Router, type Request, type Response } from "express";
import { ZodError } from "zod/v4";
import {
  JobCoordinatorV2,
  JobValidationError,
} from "./v2-service.js";
import {
  V2JobNotFoundError,
  V2JobAlreadyClaimedError,
  V2JobExpiredError,
  V2JobFinishedError,
  V2IdempotencyConflictError,
  V2AttemptLifecycleError,
  V2ReportConflictError,
  V2StoreError,
} from "./v2-store.js";
import { jobResultRequestSchema } from "./v2-schema.js";
import { CeoError } from "../errors.js";
import type { ConnectorControlStore } from "../connector/control-store.js";
import type { IdentityStore } from "../identity/store.js";
import { createDeviceAuthMiddleware } from "../connector/device-auth.js";

export function createConnectorJobsRouter(
  coordinator: JobCoordinatorV2,
  controlStore: ConnectorControlStore,
  identityStore: IdentityStore,
): Router {
  const router = Router();

  // All endpoints require Device Credential Authentication
  const deviceAuth = createDeviceAuthMiddleware(controlStore, identityStore);
  router.use(deviceAuth);

  // GET /api/connector/jobs/pending
  router.get("/pending", async (req: Request, res: Response) => {
    const device = res.locals.deviceIdentity;
    if (!device) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const limitParam = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 20;
    const limit = Number.isInteger(limitParam) ? limitParam : 20;

    try {
      const jobs = await coordinator.getPendingJobs(device.device_id, limit);
      res.status(200).json({ jobs });
    } catch (err) {
      if (err instanceof V2StoreError) {
        res.status(503).json({ error: "QUEUE_UNAVAILABLE", message: err.message });
        return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });

  // POST /api/connector/jobs/:job_id/claim
  router.post("/:job_id/claim", async (req: Request, res: Response) => {
    const device = res.locals.deviceIdentity;
    if (!device) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const jobId = typeof req.params.job_id === "string" ? req.params.job_id : "";
    const { attempt_id, claim_token } = req.body ?? {};

    if (!jobId || typeof attempt_id !== "string" || typeof claim_token !== "string") {
      res.status(400).json({ error: "INVALID_REQUEST", message: "job_id, attempt_id, and claim_token are required." });
      return;
    }

    try {
      const result = await coordinator.claimJob(
        device.device_id,
        jobId,
        attempt_id,
        claim_token,
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof JobValidationError) {
        res.status(400).json({ error: "INVALID_REQUEST", message: err.message });
        return;
      }
      if (err instanceof V2JobNotFoundError) {
        res.status(404).json({ error: "JOB_NOT_FOUND" });
        return;
      }
      if (err instanceof V2JobAlreadyClaimedError) {
        res.status(409).json({ error: "JOB_ALREADY_CLAIMED" });
        return;
      }
      if (err instanceof V2JobExpiredError) {
        res.status(410).json({ error: "JOB_EXPIRED" });
        return;
      }
      if (err instanceof V2JobFinishedError) {
        res.status(409).json({ error: "JOB_FINISHED" });
        return;
      }
      if (err instanceof V2IdempotencyConflictError) {
        res.status(409).json({ error: "IDEMPOTENCY_CONFLICT" });
        return;
      }
      if (err instanceof V2StoreError) {
        res.status(503).json({ error: "QUEUE_UNAVAILABLE", message: err.message });
        return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });

  // POST /api/connector/jobs/:job_id/start
  router.post("/:job_id/start", async (req: Request, res: Response) => {
    const device = res.locals.deviceIdentity;
    if (!device) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const jobId = typeof req.params.job_id === "string" ? req.params.job_id : "";
    const { attempt_id, claim_token } = req.body ?? {};

    if (!jobId || typeof attempt_id !== "string" || typeof claim_token !== "string") {
      res.status(400).json({ error: "INVALID_REQUEST", message: "job_id, attempt_id, and claim_token are required." });
      return;
    }

    try {
      const result = await coordinator.startJob(
        device.device_id,
        jobId,
        attempt_id,
        claim_token,
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof JobValidationError) {
        res.status(400).json({ error: "INVALID_REQUEST", message: err.message });
        return;
      }
      if (err instanceof V2JobNotFoundError) {
        res.status(404).json({ error: "JOB_NOT_FOUND" });
        return;
      }
      if (err instanceof V2AttemptLifecycleError) {
        res.status(409).json({ error: err.code, message: err.message });
        return;
      }
      if (err instanceof V2StoreError) {
        res.status(503).json({ error: "QUEUE_UNAVAILABLE", message: err.message });
        return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });

  // POST /api/connector/jobs/:job_id/result
  router.post("/:job_id/result", async (req: Request, res: Response) => {
    const device = res.locals.deviceIdentity;
    if (!device) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const jobId = typeof req.params.job_id === "string" ? req.params.job_id : "";
    if (!jobId) {
      res.status(400).json({ error: "INVALID_REQUEST", message: "job_id is required." });
      return;
    }

    let parsedBody;
    try {
      parsedBody = jobResultRequestSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ error: "INVALID_REQUEST", issues: err.issues });
        return;
      }
      res.status(400).json({ error: "INVALID_REQUEST" });
      return;
    }

    try {
      const outcome = await coordinator.submitJobResult(
        device.device_id,
        jobId,
        parsedBody.attempt_id,
        parsedBody.claim_token,
        parsedBody.result,
        parsedBody.payload_sha256,
      );
      res.status(200).json(outcome);
    } catch (err) {
      if (err instanceof JobValidationError) {
        res.status(400).json({ error: "INVALID_REQUEST", message: err.message });
        return;
      }
      if (err instanceof V2JobNotFoundError) {
        res.status(404).json({ error: "JOB_NOT_FOUND" });
        return;
      }
      if (err instanceof V2ReportConflictError) {
        res.status(409).json({ error: "RESULT_CONFLICT", message: err.message });
        return;
      }
      if (err instanceof V2AttemptLifecycleError) {
        res.status(409).json({ error: err.code, message: err.message });
        return;
      }
      if (err instanceof CeoError) {
        if (err.code === "VALIDATION_FAILED" && err.message.includes("RESULT_CONFLICT")) {
          res.status(409).json({ error: "RESULT_CONFLICT", message: err.message });
          return;
        }
        res.status(400).json({ error: err.code, message: err.message });
        return;
      }
      if (err instanceof V2StoreError) {
        res.status(503).json({ error: "QUEUE_UNAVAILABLE", message: err.message });
        return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });

  // POST /api/connector/jobs/:job_id/report
  router.post("/:job_id/report", async (req: Request, res: Response) => {
    const device = res.locals.deviceIdentity;
    if (!device) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const jobId = typeof req.params.job_id === "string" ? req.params.job_id : "";
    const { attempt_id, claim_token, report } = req.body ?? {};

    if (!jobId || typeof attempt_id !== "string" || typeof claim_token !== "string") {
      res.status(400).json({ error: "INVALID_REQUEST", message: "job_id, attempt_id, and claim_token are required." });
      return;
    }

    try {
      const result = await coordinator.reportJob(
        device.device_id,
        jobId,
        attempt_id,
        claim_token,
        report,
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ error: "INVALID_REPORT", issues: err.issues });
        return;
      }
      if (err instanceof JobValidationError) {
        res.status(400).json({ error: "INVALID_REQUEST", message: err.message });
        return;
      }
      if (err instanceof V2JobNotFoundError) {
        res.status(404).json({ error: "JOB_NOT_FOUND" });
        return;
      }
      if (err instanceof V2ReportConflictError) {
        const error = err.message === "RESULT_REQUIRED" || err.message === "RESULT_CONFLICT" ? err.message : "REPORT_CONFLICT";
        res.status(409).json({ error, message: err.message });
        return;
      }
      if (err instanceof V2AttemptLifecycleError) {
        res.status(409).json({ error: err.code, message: err.message });
        return;
      }
      if (err instanceof V2StoreError) {
        res.status(503).json({ error: "QUEUE_UNAVAILABLE", message: err.message });
        return;
      }
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });

  return router;
}
