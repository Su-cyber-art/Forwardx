import { z } from "zod";
import { nanoid } from "nanoid";
import jwt from "jsonwebtoken";
import { COOKIE_NAME } from "../../shared/const";
import { getSessionCookieOptions } from "../_core/cookies";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { ENV } from "../env";
import * as db from "../db";

interface CaptchaEntry {
  question: string;
  answer: number;
  expiresAt: number;
}

const captchaStore = new Map<string, CaptchaEntry>();
const loginFailStore = new Map<string, { count: number; lastFailAt: number }>();
const LOGIN_FAIL_THRESHOLD = 1;
const LOGIN_FAIL_WINDOW_MS = 30 * 60 * 1000;

function generateCaptcha(): { captchaId: string; question: string } {
  const a = Math.floor(Math.random() * 20) + 1;
  const b = Math.floor(Math.random() * 20) + 1;
  const ops = [
    { symbol: "+", fn: (x: number, y: number) => x + y },
    { symbol: "-", fn: (x: number, y: number) => x - y },
  ];
  const op = ops[Math.floor(Math.random() * ops.length)];
  const answer = op.fn(a, b);
  const question = `${a} ${op.symbol} ${b} = ?`;
  const captchaId = nanoid(16);
  captchaStore.set(captchaId, { question, answer, expiresAt: Date.now() + 5 * 60 * 1000 });
  for (const [key, value] of captchaStore) {
    if (value.expiresAt < Date.now()) captchaStore.delete(key);
  }
  return { captchaId, question };
}

function verifyCaptcha(captchaId: string, captchaAnswer: number): boolean {
  const entry = captchaStore.get(captchaId);
  if (!entry) return false;
  captchaStore.delete(captchaId);
  if (entry.expiresAt < Date.now()) return false;
  return entry.answer === captchaAnswer;
}

function getLoginFailKey(ip: string, username: string) {
  return `${ip}:${username}`;
}

function recordLoginFail(ip: string, username: string) {
  const key = getLoginFailKey(ip, username);
  const entry = loginFailStore.get(key);
  const now = Date.now();
  if (entry && now - entry.lastFailAt < LOGIN_FAIL_WINDOW_MS) {
    entry.count += 1;
    entry.lastFailAt = now;
  } else {
    loginFailStore.set(key, { count: 1, lastFailAt: now });
  }
}

function needsCaptcha(ip: string, username: string): boolean {
  const key = getLoginFailKey(ip, username);
  const entry = loginFailStore.get(key);
  if (!entry) return false;
  if (Date.now() - entry.lastFailAt > LOGIN_FAIL_WINDOW_MS) {
    loginFailStore.delete(key);
    return false;
  }
  return entry.count >= LOGIN_FAIL_THRESHOLD;
}

function clearLoginFail(ip: string, username: string) {
  loginFailStore.delete(getLoginFailKey(ip, username));
}

export const authRouter = router({
  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.user) return null;
    const { password, ...safeUser } = ctx.user;
    return safeUser;
  }),

  getCaptcha: publicProcedure.query(() => {
    return generateCaptcha();
  }),

  needsCaptcha: publicProcedure
    .input(z.object({ username: z.string() }))
    .query(({ input, ctx }) => {
      const ip = ctx.req.ip || ctx.req.socket.remoteAddress || "unknown";
      return { required: needsCaptcha(ip, input.username) };
    }),

  login: publicProcedure
    .input(z.object({
      username: z.string().min(1, "请输入用户名"),
      password: z.string().min(1, "请输入密码"),
      captchaId: z.string().optional(),
      captchaAnswer: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const ip = ctx.req.ip || ctx.req.socket.remoteAddress || "unknown";

      if (needsCaptcha(ip, input.username)) {
        if (!input.captchaId || input.captchaAnswer === undefined) {
          throw new Error("CAPTCHA_REQUIRED");
        }
        if (!verifyCaptcha(input.captchaId, input.captchaAnswer)) {
          throw new Error("验证码错误，请重新输入");
        }
      }

      const user = await db.authenticateUser(input.username, input.password);
      if (!user) {
        recordLoginFail(ip, input.username);
        if (needsCaptcha(ip, input.username)) {
          throw new Error("CAPTCHA_REQUIRED_AFTER_FAIL");
        }
        throw new Error("用户名或密码错误");
      }

      clearLoginFail(ip, input.username);
      const token = jwt.sign({ userId: user.id }, ENV.cookieSecret, { expiresIn: "10d" });
      ctx.res.cookie(COOKIE_NAME, token, getSessionCookieOptions(ctx.req));
      const { password, ...safeUser } = user;
      return safeUser;
    }),

  register: publicProcedure
    .input(z.object({
      username: z.string().min(2, "用户名至少2个字符").max(64),
      password: z.string().min(6, "密码至少6个字符"),
      name: z.string().max(64).optional(),
      email: z.string().email("邮箱格式不正确").optional(),
      captchaId: z.string(),
      captchaAnswer: z.number(),
    }))
    .mutation(async ({ input }) => {
      if (!verifyCaptcha(input.captchaId, input.captchaAnswer)) {
        throw new Error("验证码错误，请重新输入");
      }
      const existing = await db.getUserByUsername(input.username);
      if (existing) {
        throw new Error("用户名已存在");
      }
      const { captchaId: _captchaId, captchaAnswer: _captchaAnswer, ...userData } = input;
      const id = await db.registerUser(userData);
      return { id, message: "注册成功，请联系管理员开通权限" };
    }),

  logout: publicProcedure.mutation(({ ctx }) => {
    const cookieOptions = getSessionCookieOptions(ctx.req);
    ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
    return { success: true } as const;
  }),

  changePassword: protectedProcedure
    .input(z.object({
      oldPassword: z.string().min(1, "请输入当前密码"),
      newPassword: z.string().min(6, "新密码至少6个字符"),
    }))
    .mutation(async ({ input, ctx }) => {
      const success = await db.changeUserPassword(ctx.user.id, input.oldPassword, input.newPassword);
      if (!success) {
        throw new Error("当前密码错误");
      }
      return { success: true };
    }),

  updateProfile: protectedProcedure
    .input(z.object({
      name: z.string().min(1).max(64).optional(),
      email: z.string().email().max(320).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await db.updateUserProfile(ctx.user.id, input);
      return { success: true };
    }),
});
