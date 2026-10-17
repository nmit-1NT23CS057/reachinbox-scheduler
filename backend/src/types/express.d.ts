import "express-session";

declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      name: string;
      avatarUrl: string | null;
    }
  }
}

declare module "express-session" {
  interface SessionData {
    slackOAuthState?: string;
  }
}

export {};
