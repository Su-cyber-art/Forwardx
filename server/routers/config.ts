import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";

export const configRouter = router({
    exportAll: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      const userId = isAdmin ? undefined : ctx.user.id;
      const [hosts, rules, tokens, users] = await Promise.all([
        db.getHosts(userId),
        db.getForwardRules(userId),
        db.getAgentTokens(userId),
        isAdmin ? db.getAllUsers() : Promise.resolve([]),
      ]);
      return {
        version: 3,
        exportedAt: new Date().toISOString(),
        scope: isAdmin ? "all" : "self",
        owner: { id: ctx.user.id, username: (ctx.user as any).username, role: ctx.user.role },
        hosts: hosts.map((h: any) => ({
          id: h.id,
          userId: h.userId,
          name: h.name,
          ip: h.ip,
          entryIp: h.entryIp,
          hostType: h.hostType,
          agentToken: h.agentToken,
          osInfo: h.osInfo,
          cpuInfo: h.cpuInfo,
          memoryTotal: h.memoryTotal,
          networkInterface: h.networkInterface,
          portRangeStart: h.portRangeStart,
          portRangeEnd: h.portRangeEnd,
          isOnline: h.isOnline,
          lastHeartbeat: h.lastHeartbeat,
          createdAt: h.createdAt,
        })),
        rules: rules.map((r: any) => ({
          id: r.id,
          userId: r.userId,
          hostId: r.hostId,
          name: r.name,
          forwardType: r.forwardType,
          protocol: r.protocol,
          sourcePort: r.sourcePort,
          targetIp: r.targetIp,
          targetPort: r.targetPort,
          isEnabled: r.isEnabled,
        })),
        agentTokens: tokens.map((t: any) => ({
          id: t.id,
          userId: t.userId,
          token: t.token,
          description: t.description,
          isUsed: t.isUsed,
          hostId: t.hostId,
          createdAt: t.createdAt,
        })),
        users: users.map((u: any) => ({
          id: u.id,
          username: u.username,
          name: u.name,
          email: u.email,
          role: u.role,
          canAddRules: u.canAddRules,
          trafficLimit: u.trafficLimit,
          trafficUsed: u.trafficUsed,
          gostRateLimitIn: (u as any).gostRateLimitIn,
          gostRateLimitOut: (u as any).gostRateLimitOut,
          expiresAt: u.expiresAt,
          trafficAutoReset: u.trafficAutoReset,
          trafficResetDay: u.trafficResetDay,
        })),
      };
    }),

    importAll: adminProcedure
      .input(
        z.object({
          mode: z.enum(["merge", "replace"]).default("merge"),
          payload: z.object({
            version: z.number().optional(),
            hosts: z.array(z.any()).optional(),
            rules: z.array(z.any()).optional(),
            agentTokens: z.array(z.any()).optional(),
          }),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { mode, payload } = input;
        const summary = {
          hosts: { created: 0, skipped: 0 },
          agentTokens: { created: 0, skipped: 0 },
          rules: { created: 0, skipped: 0 },
        };

        if (mode === "replace") {
          const existRules = await db.getForwardRules(ctx.user.id);
          for (const r of existRules) await db.deleteForwardRule(r.id);
          const existHosts = await db.getHosts(ctx.user.id);
          for (const h of existHosts) await db.deleteHost(h.id);
          const existTokens = await db.getAgentTokens(ctx.user.id);
          for (const t of existTokens) await db.deleteAgentToken(t.id);
        }

        const hostIdMap = new Map<number, number>();
        const existingHosts = await db.getHosts(ctx.user.id);
        const existHostByName = new Map(existingHosts.map((h: any) => [h.name, h.id] as const));
        const existHostByToken = new Map(
          existingHosts.filter((h: any) => h.agentToken).map((h: any) => [h.agentToken, h.id] as const)
        );
        for (const h of payload.hosts || []) {
          let existId: number | undefined;
          if (h.agentToken && existHostByToken.has(h.agentToken)) {
            existId = existHostByToken.get(h.agentToken);
          } else if (existHostByName.has(h.name)) {
            existId = existHostByName.get(h.name);
          }
          if (existId) {
            hostIdMap.set(Number(h.id), Number(existId));
            summary.hosts.skipped += 1;
            continue;
          }
          const newId = await db.createHost({
            name: h.name,
            ip: h.ip || "unknown",
            entryIp: h.entryIp ?? null,
            hostType: h.hostType || "slave",
            agentToken: h.agentToken ?? null,
            osInfo: h.osInfo ?? null,
            cpuInfo: h.cpuInfo ?? null,
            memoryTotal: h.memoryTotal ?? null,
            networkInterface: h.networkInterface ?? null,
            portRangeStart: h.portRangeStart ?? null,
            portRangeEnd: h.portRangeEnd ?? null,
            isOnline: false,
            userId: ctx.user.id,
          });
          hostIdMap.set(Number(h.id), Number(newId));
          summary.hosts.created += 1;
        }

        // Agent Tokens
        const existingTokens = await db.getAgentTokens(ctx.user.id);
        const existTokenSet = new Set(existingTokens.map((t: any) => t.token));
        for (const t of payload.agentTokens || []) {
          if (existTokenSet.has(t.token)) { summary.agentTokens.skipped += 1; continue; }
          await db.createAgentToken({
            token: t.token,
            description: t.description ?? null,
            userId: ctx.user.id,
          });
          if (t.isUsed && t.hostId) {
            const newHostId = hostIdMap.get(Number(t.hostId));
            if (newHostId) {
              await db.markAgentTokenUsed(t.token, Number(newHostId));
            }
          }
          summary.agentTokens.created += 1;
        }

        // 规则
        const existingRules = await db.getForwardRules(ctx.user.id);
        const ruleKey = (r: any) => `${r.hostId}|${r.sourcePort}|${r.protocol}|${r.forwardType}`;
        const existRuleKeys = new Set(existingRules.map((r: any) => ruleKey(r)));
        for (const r of payload.rules || []) {
          const newHostId = hostIdMap.get(Number(r.hostId));
          if (!newHostId) { summary.rules.skipped += 1; continue; }
          const k = ruleKey({ ...r, hostId: newHostId });
          if (existRuleKeys.has(k)) { summary.rules.skipped += 1; continue; }
          await db.createForwardRule({
            userId: ctx.user.id,
            hostId: newHostId,
            name: r.name,
            forwardType: r.forwardType,
            protocol: r.protocol,
            sourcePort: Number(r.sourcePort),
            targetIp: r.targetIp,
            targetPort: Number(r.targetPort),
            isEnabled: !!r.isEnabled,
            isRunning: false,
          });
          summary.rules.created += 1;
        }

        return { success: true, mode, summary };
      }),
  });
