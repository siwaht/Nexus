import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import localAuthRouter from "./localAuth";
import providersRouter from "./providers";
import modelsRouter from "./models";
import conversationsRouter from "./conversations";
import chatRouter from "./chat";
import filesRouter from "./files";
import memoryRouter from "./memory";
import toolsRouter from "./tools";
import mcpRouter from "./mcp";
import secretsRouter from "./secrets";
import skillsRouter from "./skills";
import agentsRouter from "./agents";
import browserRouter from "./browser";
import dataRouter from "./data";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(localAuthRouter);
router.use(providersRouter);
router.use(modelsRouter);
router.use(conversationsRouter);
router.use(chatRouter);
router.use(filesRouter);
router.use(memoryRouter);
router.use(toolsRouter);
router.use(mcpRouter);
router.use(secretsRouter);
router.use(skillsRouter);
router.use(agentsRouter);
router.use(browserRouter);
router.use(dataRouter);

export default router;
