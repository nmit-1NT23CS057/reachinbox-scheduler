import crypto from "node:crypto";
import { NextFunction, Request, Response, Router } from "express";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { prisma } from "./db";
import { env } from "./config";

export const authRouter = Router();

if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    callbackURL: env.GOOGLE_CALLBACK_URL,
    state: true
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value;
      if (!email) return done(new Error("Google did not return an email address"));
      const userData = {
        email,
        name: profile.displayName || email,
        avatarUrl: profile.photos?.[0]?.value ?? null
      };
      const byGoogleId = await prisma.user.findUnique({ where: { googleId: profile.id } });
      const user = byGoogleId
        ? await prisma.user.update({ where: { id: byGoogleId.id }, data: userData })
        : await prisma.user.upsert({
          where: { email },
          update: { ...userData, googleId: profile.id },
          create: { googleId: profile.id, ...userData }
        });
      return done(null, {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl
      });
    } catch (error) {
      return done(error as Error);
    }
  }));
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    done(null, user ? {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl
    } : false);
  } catch (error) {
    done(error);
  }
});

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.isAuthenticated() && req.user) {
    next();
    return;
  }
  res.status(401).json({ error: "Authentication required" });
}

authRouter.get("/google", (req, res, next) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    res.status(503).json({ error: "Google OAuth is not configured" });
    return;
  }
  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

authRouter.get("/google/callback", (req, res, next) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    res.status(503).send("Google OAuth is not configured");
    return;
  }
  passport.authenticate("google", {
    failureRedirect: `${env.FRONTEND_URL}/?login=failed`
  }, (error: Error | null, user: Express.User | false) => {
    if (error || !user) {
      res.redirect(`${env.FRONTEND_URL}/?login=failed`);
      return;
    }
    req.logIn(user, (loginError) => {
      if (loginError) {
        next(loginError);
        return;
      }
      res.redirect(`${env.FRONTEND_URL}/`);
    });
  })(req, res, next);
});

authRouter.get("/me", (req, res) => {
  if (!req.isAuthenticated() || !req.user) {
    res.json({ user: null });
    return;
  }
  res.json({ user: req.user });
});

authRouter.post("/logout", (req, res, next) => {
  req.logout((error) => {
    if (error) {
      next(error);
      return;
    }
    req.session.destroy((sessionError) => {
      if (sessionError) {
        next(sessionError);
        return;
      }
      res.clearCookie("scheduler.sid");
      res.status(204).end();
    });
  });
});

authRouter.get("/slack", requireAuth, (req, res) => {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    res.status(503).json({ error: "Slack OAuth is not configured" });
    return;
  }
  const state = crypto.randomBytes(24).toString("hex");
  req.session.slackOAuthState = state;
  const authorizeUrl = new URL("https://slack.com/oauth/v2/authorize");
  authorizeUrl.searchParams.set("client_id", env.SLACK_CLIENT_ID);
  authorizeUrl.searchParams.set("scope", "incoming-webhook");
  authorizeUrl.searchParams.set("redirect_uri", env.SLACK_CALLBACK_URL);
  authorizeUrl.searchParams.set("state", state);
  res.redirect(authorizeUrl.toString());
});

authRouter.get("/slack/callback", requireAuth, async (req, res, next) => {
  try {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!state || state !== req.session.slackOAuthState) {
      res.status(400).send("Invalid Slack OAuth state");
      return;
    }
    delete req.session.slackOAuthState;
    if (req.query.error) {
      res.redirect(`${env.FRONTEND_URL}/?slack=failed`);
      return;
    }
    if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
      res.status(503).send("Slack OAuth is not configured");
      return;
    }
    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.SLACK_CLIENT_ID,
        client_secret: env.SLACK_CLIENT_SECRET,
        code: String(req.query.code ?? ""),
        redirect_uri: env.SLACK_CALLBACK_URL
      })
    });
    const result = await response.json() as {
      ok: boolean;
      access_token?: string;
      incoming_webhook?: { url?: string };
      error?: string;
    };
    if (!response.ok || !result.ok || !result.access_token || !result.incoming_webhook?.url) {
      throw new Error(`Slack OAuth exchange failed: ${result.error ?? response.statusText}`);
    }
    const encrypted = encryptSlackCredentials({
      token: result.access_token,
      webhookUrl: result.incoming_webhook.url
    });
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { slackWebhookEncrypted: encrypted }
    });
    res.redirect(`${env.FRONTEND_URL}/?slack=connected`);
  } catch (error) {
    next(error);
  }
});

authRouter.delete("/slack", requireAuth, async (req, res, next) => {
  try {
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { slackWebhookEncrypted: null }
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

authRouter.get("/slack/status", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { slackWebhookEncrypted: true }
    });
    res.json({ connected: Boolean(user?.slackWebhookEncrypted) });
  } catch (error) {
    next(error);
  }
});

export function encryptSlackCredentials(value: { token: string; webhookUrl: string }): string {
  const key = Buffer.from(env.SLACK_TOKEN_ENCRYPTION_KEY ?? "", "hex");
  if (key.length !== 32) throw new Error("SLACK_TOKEN_ENCRYPTION_KEY must be 64 hex characters");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), ciphertext.toString("hex")].join(":");
}

export function decryptSlackCredentials(value: string): { token: string; webhookUrl: string } {
  const key = Buffer.from(env.SLACK_TOKEN_ENCRYPTION_KEY ?? "", "hex");
  if (key.length !== 32) throw new Error("SLACK_TOKEN_ENCRYPTION_KEY must be 64 hex characters");
  const [ivHex, tagHex, ciphertextHex] = value.split(":");
  if (!ivHex || !tagHex || !ciphertextHex) throw new Error("Invalid encrypted Slack credentials");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final()
  ]).toString("utf8");
  return JSON.parse(plaintext) as { token: string; webhookUrl: string };
}
