import { systemRouter } from "./_core/systemRouter";
import { paymentRouter } from "./payment";
import { router } from "./_core/trpc";
import { agentTokensRouter } from "./routers/agentTokens";
import { authRouter } from "./routers/auth";
import { configRouter } from "./routers/config";
import { dashboardRouter } from "./routers/dashboard";
import { hostsRouter } from "./routers/hosts";
import { plansRouter } from "./routers/plans";
import { rulesRouter } from "./routers/rules";
import { tunnelsRouter } from "./routers/tunnels";
import { usersRouter } from "./routers/users";

export const appRouter = router({
  system: systemRouter,
  payment: paymentRouter,
  plans: plansRouter,
  auth: authRouter,
  dashboard: dashboardRouter,
  users: usersRouter,
  hosts: hostsRouter,
  rules: rulesRouter,
  tunnels: tunnelsRouter,
  agentTokens: agentTokensRouter,
  config: configRouter,
});

export type AppRouter = typeof appRouter;
