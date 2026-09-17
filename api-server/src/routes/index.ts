import { Router, type IRouter } from "express";
import healthRouter from "./health";
import storageRouter from "./storage";
import musicRouter from "./music";

const router: IRouter = Router();

router.use(healthRouter);
router.use(musicRouter);
router.use(storageRouter);

export default router;
