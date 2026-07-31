import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import localAuthRouter from "./localAuth";
import providersRouter from "./providers";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(localAuthRouter);
router.use(providersRouter);

export default router;
