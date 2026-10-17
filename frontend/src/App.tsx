import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  Clock3,
  Inbox,
  LogOut,
  Mail,
  Plus,
  Search,
  Send,
  Settings2,
  Slack,
  X
} from "lucide-react";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

type User = { id: string; name: string; email: string; avatarUrl: string | null };
type EmailStatus = "SCHEDULED" | "PROCESSING" | "SENT" | "FAILED";
type EmailRecord = {
  id: string;
  recipientEmail: string;
  senderEmail: string;
  subject: string;
  scheduledAt: string;
  sentAt: string | null;
  status: EmailStatus;
  failureReason: string | null;
};
type View = "all" | "scheduled" | "sent";
type QueueStats = { waiting: number; active: number; delayed: number; completed: number; failed: number };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...init?.headers }
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json() as { error?: string };
      message = body.error || message;
    } catch {
      message = response.statusText || message;
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [view, setView] = useState<View>("all");
  const [emails, setEmails] = useState<EmailRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [slackConnected, setSlackConnected] = useState(false);
  const [slackBusy, setSlackBusy] = useState(false);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const pageSize = 50;

  useEffect(() => {
    api<{ user: User | null }>("/auth/me")
      .then(({ user: currentUser }) => setUser(currentUser))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not connect to API"))
      .finally(() => setAuthLoading(false));
  }, []);

  const loadEmails = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      view,
      page: String(page),
      pageSize: String(pageSize)
    });
    if (appliedSearch) params.set("q", appliedSearch);
    try {
      const result = await api<{ emails: EmailRecord[]; total: number }>(`/api/emails?${params}`);
      setEmails(result.emails);
      setTotal(result.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load emails");
    } finally {
      setLoading(false);
    }
  }, [user, view, page, appliedSearch]);

  useEffect(() => {
    void loadEmails();
  }, [loadEmails]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => void loadEmails(), 5000);
    return () => window.clearInterval(timer);
  }, [user, loadEmails]);

  useEffect(() => {
    if (!user) return;
    api<{ connected: boolean }>("/auth/slack/status")
      .then((result) => setSlackConnected(result.connected))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Slack status unavailable"));
    const refreshQueue = () => {
      api<QueueStats>("/api/queue/stats").then(setQueueStats).catch(() => setQueueStats(null));
    };
    refreshQueue();
    const timer = window.setInterval(refreshQueue, 15_000);
    return () => window.clearInterval(timer);
  }, [user]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("slack") === "connected") {
      setToast("Slack notifications connected");
      setSlackConnected(true);
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.has("slack")) {
      setError("Slack connection was not completed. Please try again.");
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (params.get("login") === "failed") {
      setError("Google sign-in could not be completed.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const sentCount = useMemo(() => emails.filter((email) => email.status === "SENT").length, [emails]);

  async function logout() {
    try {
      await api<void>("/auth/logout", { method: "POST" });
      setUser(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not log out");
    }
  }

  async function disconnectSlack() {
    setSlackBusy(true);
    try {
      await api<void>("/auth/slack", { method: "DELETE" });
      setSlackConnected(false);
      setToast("Slack notifications disconnected");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disconnect Slack");
    } finally {
      setSlackBusy(false);
    }
  }

  if (authLoading) {
    return <div className="screen-center"><span className="spinner" />Loading your workspace…</div>;
  }

  if (!user) {
    return (
      <main className="login-page">
        <div className="login-brand"><span className="brand-mark"><Send size={19} /></span> ReachInbox</div>
        <section className="login-card">
          <div className="login-icon"><Inbox size={24} /></div>
          <p className="eyebrow">YOUR EMAIL, ON YOUR SCHEDULE</p>
          <h1>Send with intention.</h1>
          <p className="login-copy">Plan your outreach, keep every send on track, and let your queue do the rest.</p>
          {error && <div className="alert error-alert">{error}</div>}
          <a className="button google-button" href={`${API_URL}/auth/google`}>
            <GoogleMark /> Continue with Google
          </a>
          <p className="login-footnote">Secure sign-in · Your emails stay yours</p>
        </section>
        <span className="login-footer">REACHINBOX · EMAIL SCHEDULER</span>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="ReachInbox home">
          <span className="brand-mark"><Send size={17} /></span>
          <span>ReachInbox<span className="brand-dot">.</span></span>
        </a>
        <div className="topbar-right">
          <a className="queue-link" href={`${API_URL}/admin/queues`} target="_blank" rel="noreferrer">
            <span className="live-dot" /> Queue <span className="queue-count">{queueStats?.waiting ?? "—"}</span>
          </a>
          <div className="user-menu">
            {user.avatarUrl
              ? <img className="avatar" src={user.avatarUrl} alt="" />
              : <span className="avatar avatar-fallback">{user.name.slice(0, 1).toUpperCase()}</span>}
            <span className="user-label"><strong>{user.name}</strong><small>{user.email}</small></span>
            <button className="icon-button logout-button" onClick={logout} title="Log out" aria-label="Log out">
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </header>

      <main className="main-content">
        <div className="page-heading">
          <div>
            <p className="eyebrow">YOUR WORKSPACE</p>
            <h1>Email campaigns</h1>
            <p className="page-subtitle">A clear view of everything going out.</p>
          </div>
          <button className="button primary-button" onClick={() => setComposeOpen(true)}>
            <Plus size={18} /> Compose new email
          </button>
        </div>

        <section className="summary-row" aria-label="Queue summary">
          <SummaryCard icon={<Clock3 size={18} />} label="Waiting to send" value={queueStats?.delayed ?? "—"} tone="violet" />
          <SummaryCard icon={<Send size={18} />} label="Sent on page" value={sentCount} tone="green" />
          <SummaryCard icon={<Settings2 size={18} />} label="In queue" value={queueStats?.waiting ?? "—"} tone="blue" />
        </section>

        <section className="email-panel">
          <div className="panel-toolbar">
            <div className="tabs" role="tablist" aria-label="Email status">
              <button
                role="tab"
                aria-selected={view === "all"}
                className={`tab ${view === "all" ? "active" : ""}`}
                onClick={() => { setView("all"); setPage(1); }}
              >
                <Inbox size={16} /> All emails
              </button>
              <button
                role="tab"
                aria-selected={view === "scheduled"}
                className={`tab ${view === "scheduled" ? "active" : ""}`}
                onClick={() => { setView("scheduled"); setPage(1); }}
              >
                <Clock3 size={16} /> Scheduled
              </button>
              <button
                role="tab"
                aria-selected={view === "sent"}
                className={`tab ${view === "sent" ? "active" : ""}`}
                onClick={() => { setView("sent"); setPage(1); }}
              >
                <Send size={16} /> Sent
              </button>
            </div>
            <div className="toolbar-actions">
              {slackConnected ? (
                <button className="button subtle-button slack-connected" onClick={disconnectSlack} disabled={slackBusy}>
                  <Check size={15} /> Slack connected
                </button>
              ) : (
                <a className="button subtle-button" href={`${API_URL}/auth/slack`}>
                  <Slack size={16} /> Connect Slack
                </a>
              )}
              <form className="search-box" onSubmit={(event) => {
                event.preventDefault();
                setPage(1);
                setAppliedSearch(search.trim());
              }}>
                <Search size={16} />
                <input
                  aria-label="Search emails"
                  placeholder="Search emails"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search && <button type="button" aria-label="Clear search" onClick={() => {
                  setSearch("");
                  setAppliedSearch("");
                  setPage(1);
                }}><X size={14} /></button>}
              </form>
            </div>
          </div>

          {error && <div className="alert error-alert panel-alert">{error}</div>}
          <EmailTable emails={emails} view={view} loading={loading} searched={Boolean(appliedSearch)} />
          {!loading && total > 0 && (
            <div className="pagination">
              <span>Showing {Math.min((page - 1) * pageSize + 1, total)}–{Math.min(page * pageSize, total)} of {total}</span>
              <div className="pagination-buttons">
                <button className="icon-button" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  <ArrowLeft size={16} />
                </button>
                <span>{page} / {pageCount}</span>
                <button className="icon-button" aria-label="Next page" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>
                  <ArrowRight size={16} />
                </button>
              </div>
            </div>
          )}
        </section>
        <footer className="page-footer"><span><span className="live-dot" /> Queue updates automatically</span><a href={`${API_URL}/admin/queues`} target="_blank" rel="noreferrer">View BullMQ dashboard <ArrowRight size={14} /></a></footer>
      </main>

      {composeOpen && (
        <ComposeModal
          onClose={() => setComposeOpen(false)}
          onScheduled={(count) => {
            setComposeOpen(false);
            setView("all");
            setPage(1);
            setAppliedSearch("");
            setSearch("");
            setToast(`${count} email${count === 1 ? "" : "s"} added to your schedule`);
            void loadEmails();
          }}
          onError={setError}
        />
      )}
      {toast && <div className="toast"><Check size={17} /> {toast}</div>}
    </div>
  );
}

function SummaryCard({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string | number; tone: string }) {
  return <div className="summary-card">
    <span className={`summary-icon ${tone}`}>{icon}</span>
    <span className="summary-copy"><small>{label}</small><strong>{value}</strong></span>
  </div>;
}

function EmailTable({ emails, view, loading, searched }: {
  emails: EmailRecord[];
  view: View;
  loading: boolean;
  searched: boolean;
}) {
  if (loading) {
    return <div className="table-loading"><span className="spinner" /><span>Loading {view} emails…</span></div>;
  }
  if (!emails.length) {
    const emptyTitle = view === "all"
      ? "No emails yet"
      : view === "scheduled" ? "Nothing scheduled yet" : "No sent emails yet";
    const emptyCopy = searched
      ? "Try a different recipient, subject, or keyword."
      : view === "all"
        ? "Your scheduled, sending, sent, and failed emails will appear here."
        : view === "scheduled"
          ? "Your upcoming emails will appear here once you schedule a send."
          : "Once your emails are delivered, you’ll find them right here.";
    return <div className="empty-state">
      <span className="empty-icon">{view === "scheduled" ? <Clock3 size={23} /> : view === "sent" ? <Mail size={23} /> : <Inbox size={23} />}</span>
      <h3>{searched ? "No matching emails" : emptyTitle}</h3>
      <p>{emptyCopy}</p>
    </div>;
  }
  return <div className="table-scroll">
    <table>
      <thead>
        <tr>
          <th>RECIPIENT</th><th>SUBJECT</th><th>{view === "scheduled" ? "SCHEDULED FOR" : view === "sent" ? "SENT AT" : "SCHEDULED / SENT"}</th><th>STATUS</th>
        </tr>
      </thead>
      <tbody>
        {emails.map((email) => (
          <tr key={email.id}>
            <td><div className="recipient-cell"><span className="recipient-avatar">{email.recipientEmail.slice(0, 1).toUpperCase()}</span><span>{email.recipientEmail}</span></div></td>
            <td className="subject-cell">{email.subject}</td>
            <td className="date-cell">{formatDate(view === "sent" ? email.sentAt ?? email.scheduledAt : view === "all" ? email.sentAt ?? email.scheduledAt : email.scheduledAt)}</td>
            <td><StatusPill status={email.status} title={email.failureReason ?? undefined} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>;
}

function StatusPill({ status, title }: { status: EmailStatus; title?: string }) {
  const label: Record<EmailStatus, string> = {
    SCHEDULED: "Scheduled",
    PROCESSING: "Sending",
    SENT: "Sent",
    FAILED: "Failed"
  };
  return <span className={`status-pill status-${status.toLowerCase()}`} title={title}><span />{label[status]}</span>;
}

function ComposeModal({ onClose, onScheduled, onError }: {
  onClose: () => void;
  onScheduled: (count: number) => void;
  onError: (message: string) => void;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [senderEmail, setSenderEmail] = useState("");
  const [startAt, setStartAt] = useState(() => {
    const date = new Date(Date.now() + 5 * 60_000);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
  });
  const [delaySeconds, setDelaySeconds] = useState(2);
  const [hourlyLimit, setHourlyLimit] = useState(200);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  async function readLeads(file?: File) {
    if (!file) return;
    setFileError("");
    try {
      const text = await file.text();
      const found = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
      const unique = [...new Set(found.map((email) => email.toLowerCase()))];
      if (!unique.length) throw new Error("No email addresses were found in that file.");
      if (unique.length > 5000) throw new Error("A schedule can include up to 5,000 unique addresses.");
      setRecipients(unique);
      setFileName(file.name);
    } catch (cause) {
      setRecipients([]);
      setFileName("");
      setFileError(cause instanceof Error ? cause.message : "Could not read that file.");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    onError("");
    setSubmitting(true);
    try {
      const result = await api<{ count: number }>("/api/emails", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          recipients,
          senderEmail,
          subject,
          body,
          startAt: new Date(startAt).toISOString(),
          delayBetweenMs: Math.round(delaySeconds * 1000),
          hourlyLimit
        })
      });
      onScheduled(result.count);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not schedule your emails");
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !submitting) onClose();
  }}>
    <section className="compose-modal" role="dialog" aria-modal="true" aria-labelledby="compose-title">
      <div className="modal-heading">
        <div><p className="eyebrow">NEW CAMPAIGN</p><h2 id="compose-title">Compose email</h2></div>
        <button className="icon-button" aria-label="Close" onClick={onClose} disabled={submitting}><X size={19} /></button>
      </div>
      <p className="modal-description">One message, delivered to each lead at a thoughtful pace.</p>
      <form onSubmit={submit}>
        <label className="field-label">Sender email
          <input required type="email" value={senderEmail} onChange={(event) => setSenderEmail(event.target.value)} placeholder="you@company.com" />
        </label>
        <label className="field-label">Subject
          <input required maxLength={998} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="A subject your recipients will recognize" />
        </label>
        <label className="field-label">Email body
          <textarea required rows={4} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Write your email…" />
        </label>
        <div className="field-label">Email leads
          <label className={`upload-zone ${recipients.length ? "has-file" : ""}`}>
            <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => void readLeads(event.target.files?.[0])} />
            {recipients.length
              ? <><span className="upload-icon success-upload"><Check size={18} /></span><span><strong>{fileName}</strong><small>{recipients.length.toLocaleString()} unique email addresses detected</small></span><span className="change-file">Change</span></>
              : <><span className="upload-icon"><ArrowDownToLine size={18} /></span><span><strong>Upload a CSV or text file</strong><small>We’ll find and deduplicate email addresses in your file</small></span></>}
          </label>
          {fileError && <span className="field-error">{fileError}</span>}
        </div>
        <div className="schedule-fields">
          <label className="field-label">Start time
            <input required type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} />
          </label>
          <label className="field-label">Delay between emails
            <div className="input-suffix"><input required type="number" min="0" max="3600" value={delaySeconds} onChange={(event) => setDelaySeconds(Number(event.target.value))} /><span>sec</span></div>
          </label>
          <label className="field-label">Hourly limit
            <div className="input-suffix"><input required type="number" min="1" max="10000" value={hourlyLimit} onChange={(event) => setHourlyLimit(Number(event.target.value))} /><span>/ hr</span></div>
          </label>
        </div>
        <div className="schedule-note"><Clock3 size={15} /><span>Emails will be paced automatically. Provider and hourly limits may extend your delivery window.</span></div>
        <div className="modal-footer">
          <span>{recipients.length ? `${recipients.length.toLocaleString()} unique recipients` : "Add recipient addresses to continue"}</span>
          <div><button type="button" className="button subtle-button" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="button primary-button" disabled={submitting || !recipients.length}>
              {submitting ? <><span className="button-spinner" /> Scheduling…</> : <><Send size={16} /> Schedule emails</>}
            </button>
          </div>
        </div>
      </form>
    </section>
  </div>;
}

function GoogleMark() {
  return <svg aria-hidden="true" viewBox="0 0 48 48" width="19" height="19">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z" transform="translate(0 4)" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.72 7.18l7.62 5.91c4.45-4.11 7.14-10.17 7.14-17.56Z" />
    <path fill="#FBBC05" d="M10.53 28.59a14.4 14.4 0 0 1-.76-4.59c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.88.93 7.55 2.56 10.78l7.97-6.19Z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.9-5.89l-7.62-5.91c-2.11 1.42-4.81 2.27-8.28 2.27-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z" />
  </svg>;
}

export default App;
