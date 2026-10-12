"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ENQUIRY_ERASE_REASONS, type EnquiryEraseReason } from "@/shared/schemas/enquiryAdmin";

import { readApiError, readCsrfToken } from "./CategoryForm";

type EnquiryRow = {
  id: string;
  reference: string;
  first_name: string | null;
  last_name: string | null;
  wedding_date: string;
  gown_count: number;
  lead_time_band: string;
  chat_channel: string | null;
  status: "new" | "read" | "archived";
  is_erased: boolean;
  created_at: string;
  handled_by: { id: string; name: string } | null;
  handled_at: string | null;
};
type ListBody = { items: EnquiryRow[]; page: number; total_pages: number };

const bandLabels: Record<string, string> = {
  comfortable: "Comfortable",
  rush: "Rush",
  in_stock_only: "In stock only",
};

function displayName(row: EnquiryRow) {
  return [row.first_name, row.last_name].filter(Boolean).join(" ") || "Erased enquiry";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(`${value}T00:00:00`),
  );
}

export function EnquiryInbox() {
  const router = useRouter();
  const pathname = usePathname();
  const current = useSearchParams();
  const [body, setBody] = useState<ListBody | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(current.get("search") ?? "");
  const [status, setStatus] = useState(current.get("status") ?? "");
  const [band, setBand] = useState(current.get("band") ?? "");

  useEffect(() => {
    // New URL state: drop the old rows and error first, and ignore a slower earlier response.
    const controller = new AbortController();
    setBody(null);
    setNotice(null);
    setLoading(true);
    fetch(`/api/admin/enquiries?${current.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error((await readApiError(response)).message);
        setBody((await response.json()) as ListBody);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setNotice(error instanceof Error ? error.message : "Could not load enquiries.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [current]);

  function apply(event: React.FormEvent) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (status) params.set("status", status);
    if (band) params.set("band", band);
    router.push(`${pathname}?${params}`);
  }

  return (
    <>
      <style>{css}</style>
      <form className="enquiry-filters" onSubmit={apply} role="search">
        <label>
          Search
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name, email or reference"
          />
        </label>
        <label>
          Handled
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All enquiries</option>
            <option value="new">Unhandled</option>
            <option value="read">Handled</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        <label>
          Lead time
          <select value={band} onChange={(event) => setBand(event.target.value)}>
            <option value="">All bands</option>
            {Object.entries(bandLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Apply filters</button>
      </form>
      {loading ? (
        <p className="loading" role="status">
          Loading enquiries…
        </p>
      ) : null}
      {notice ? (
        <p className="notice" role="alert">
          {notice}
        </p>
      ) : null}
      {body?.items.length === 0 ? (
        <p className="empty" role="status">
          No enquiries match these filters.
        </p>
      ) : null}
      <ul className="enquiry-list" aria-label="Enquiries" aria-busy={loading}>
        {body?.items.map((row) => (
          <li key={row.id}>
            <Link className="enquiry-link" href={`/admin/enquiries/${row.id}`}>
              <strong>{displayName(row)}</strong>
              <span>
                {formatDate(row.wedding_date)} · {row.gown_count} gown
                {row.gown_count === 1 ? "" : "s"}
              </span>
              <span>
                {bandLabels[row.lead_time_band] ?? row.lead_time_band} ·{" "}
                {row.chat_channel ?? "No channel"}
              </span>
              <span className={row.status === "read" ? "handled" : "unhandled"}>
                {row.status === "read"
                  ? `Handled${row.handled_by ? ` by ${row.handled_by.name}` : ""}`
                  : row.status === "archived"
                    ? "Archived"
                    : "Needs reply"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {body && body.total_pages > 1 ? (
        <nav className="pagination" aria-label="Enquiry pages">
          Page {body.page} of {body.total_pages}
        </nav>
      ) : null}
    </>
  );
}

export type EnquiryDetail = {
  id: string;
  reference: string;
  first_name: string | null;
  last_name: string | null;
  contact_number: string | null;
  email: string | null;
  wedding_date: string;
  message: string | null;
  source: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  referrer_host: string | null;
  chat_channel: string | null;
  lead_time_band: string;
  lead_time_notice: string;
  status: "new" | "read" | "archived";
  studio_email_status: string;
  bride_email_status: string;
  created_at: string;
  is_erased: boolean;
  gowns: {
    gown_id: string;
    name: string;
    price_minor: number;
    price_status: string;
    currency: string;
  }[];
  handled_by: { id: string; name: string } | null;
  handled_at: string | null;
};

export function EnquiryDetailView({ id }: { id: string }) {
  const [detail, setDetail] = useState<EnquiryDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/admin/enquiries/${encodeURIComponent(id)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error((await readApiError(response)).message);
        setDetail((await response.json()) as EnquiryDetail);
      })
      .catch((error: unknown) =>
        setNotice(error instanceof Error ? error.message : "Could not load enquiry."),
      );
  }, [id]);

  if (notice)
    return (
      <>
        <style>{css}</style>
        <p className="notice" role="alert">
          {notice}
        </p>
      </>
    );
  if (!detail)
    return (
      <>
        <style>{css}</style>
        <p role="status">Loading enquiry…</p>
      </>
    );
  const name = [detail.first_name, detail.last_name].filter(Boolean).join(" ") || "Erased enquiry";
  return (
    <>
      <style>{css}</style>
      <p>
        <Link href="/admin/enquiries">← All enquiries</Link>
      </p>
      <EnquiryActions detail={detail} onChange={setDetail} />
      <header className="detail-header">
        <div>
          <p className="eyebrow">{detail.reference}</p>
          <h1>{name}</h1>
        </div>
        <span className={detail.is_erased ? "erased badge" : "badge"}>
          {detail.is_erased
            ? "Personal data erased"
            : detail.status === "read"
              ? `Handled${detail.handled_by ? ` by ${detail.handled_by.name}` : ""}`
              : detail.status === "archived"
                ? "Archived"
                : "Needs reply"}
        </span>
      </header>
      <dl className="detail-grid">
        <div>
          <dt>Wedding date</dt>
          <dd>{formatDate(detail.wedding_date)}</dd>
        </div>
        <div>
          <dt>Gowns</dt>
          <dd>{detail.gowns.length}</dd>
        </div>
        <div>
          <dt>Lead-time band</dt>
          <dd>{bandLabels[detail.lead_time_band] ?? detail.lead_time_band}</dd>
        </div>
        <div>
          <dt>Channel</dt>
          <dd>{detail.chat_channel ?? "No channel"}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{detail.source}</dd>
        </div>
        <div>
          <dt>Submitted</dt>
          <dd>{new Date(detail.created_at).toLocaleString()}</dd>
        </div>
      </dl>
      <section className="detail-section">
        <h2>Contact</h2>
        <dl className="fields">
          <div>
            <dt>Phone</dt>
            <dd>{detail.contact_number ?? "Erased"}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{detail.email ?? "Erased"}</dd>
          </div>
        </dl>
      </section>
      <section className="detail-section">
        <h2>Message</h2>
        <p className="message">{detail.message ?? "Personal message erased."}</p>
      </section>
      <section className="detail-section">
        <h2>Notice shown</h2>
        <p>{detail.lead_time_notice}</p>
      </section>
      <section className="detail-section">
        <h2>Selected gowns</h2>
        <ul className="gowns">
          {detail.gowns.map((gown) => (
            <li key={gown.gown_id}>
              <strong>{gown.name}</strong>
              <span>
                {gown.price_status === "priced"
                  ? `${gown.currency} ${gown.price_minor.toLocaleString()}`
                  : gown.price_status}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

const eraseReasonLabels: Record<EnquiryEraseReason, string> = {
  data_subject_request: "The bride asked for her data to be erased",
  retention_policy: "Retention policy",
  duplicate_or_test: "Duplicate or test enquiry",
};

type ActionError = { message: string; request_id?: string; fields?: Record<string, string> };

function errorText(error: ActionError) {
  return error.request_id ? `${error.message} (reference ${error.request_id})` : error.message;
}

async function send(url: string, method: "PATCH" | "POST", body: unknown) {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-csrf-token": readCsrfToken() ?? "" },
    body: JSON.stringify(body),
  });
  if (response.ok) return { ok: true as const, detail: (await response.json()) as EnquiryDetail };
  return { ok: false as const, status: response.status, error: await readApiError(response) };
}

/**
 * KBS-23-4: handled toggle and the erase confirmation. Native modal <dialog>
 * gives the focus trap and Escape. Neither action is offered once erased:
 * the API freezes an erased enquiry (409), so the UI does not pretend.
 */
function EnquiryActions({
  detail,
  onChange,
}: {
  detail: EnquiryDetail;
  onChange: (detail: EnquiryDetail) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const reasonSelect = useRef<HTMLSelectElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const url = `/api/admin/enquiries/${encodeURIComponent(detail.id)}`;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = Array.from(
        dialog.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]",
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (
        !dialog.current.contains(document.activeElement) ||
        document.activeElement === dialog.current
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  // Erased (perhaps by someone else, seen as a 409): no actions, only why.
  if (detail.is_erased)
    return error ? (
      <p className="notice" role="alert">
        {errorText(error)}
      </p>
    ) : null;
  const handled = detail.status === "read";

  function trapFocus(event: React.KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        "button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]",
      ),
    );
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (!event.currentTarget.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function run(request: Promise<Awaited<ReturnType<typeof send>>>, closeDialog = false) {
    setBusy(true);
    setError(null);
    try {
      const result = await request;
      if (result.ok) {
        if (closeDialog) dialog.current?.close();
        onChange(result.detail);
        return;
      }
      if (result.status === 409) {
        // Erased elsewhere meanwhile: show the server's current state.
        dialog.current?.close();
        const fresh = await fetch(url);
        if (fresh.ok) onChange((await fresh.json()) as EnquiryDetail);
      }
      setError(result.error);
    } catch {
      setError({ message: "Could not reach the server. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="detail-actions" aria-label="Enquiry actions">
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(send(url, "PATCH", { status: handled ? "new" : "read" }))}
      >
        {handled ? "Mark as needing reply" : "Mark handled"}
      </button>
      <button
        type="button"
        className="danger"
        disabled={busy}
        onClick={() => {
          setError(null);
          setReason("");
          dialog.current?.showModal();
          setOpen(true);
          requestAnimationFrame(() => reasonSelect.current?.focus());
        }}
      >
        Erase personal data
      </button>
      {error && !open ? (
        <p className="notice" role="alert">
          {errorText(error)}
        </p>
      ) : null}
      <dialog
        ref={dialog}
        aria-labelledby="erase-title"
        aria-describedby="erase-what"
        onClose={() => {
          setOpen(false);
          setReason("");
        }}
        onKeyDownCapture={trapFocus}
      >
        <form
          className="erase-dialog"
          onSubmit={(event) => {
            event.preventDefault();
            void run(send(`${url}/erase`, "POST", { confirm: true, reason }), true);
          }}
        >
          <h2 id="erase-title">Erase personal data?</h2>
          <div id="erase-what">
            <p>This permanently removes, for {detail.reference}:</p>
            <ul>
              <li>first and last name</li>
              <li>phone number and email</li>
              <li>her message</li>
              <li>campaign and referrer details</li>
            </ul>
            <p>
              The wedding date, gowns and lead-time notice stay for the studio&apos;s counts.{" "}
              <strong>This cannot be undone.</strong>
            </p>
          </div>
          <label>
            Reason
            <select
              ref={reasonSelect}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              aria-invalid={error?.fields?.reason ? true : undefined}
              aria-describedby={error?.fields?.reason ? "erase-reason-error" : undefined}
            >
              <option value="" disabled>
                Choose a reason
              </option>
              {ENQUIRY_ERASE_REASONS.map((value) => (
                <option key={value} value={value}>
                  {eraseReasonLabels[value]}
                </option>
              ))}
            </select>
          </label>
          {error?.fields?.reason ? (
            <p id="erase-reason-error" className="field-error">
              {error.fields.reason}
            </p>
          ) : null}
          {error && !error.fields?.reason ? (
            <p className="notice" role="alert">
              {errorText(error)}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button type="button" onClick={() => dialog.current?.close()} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="danger" disabled={busy || !reason}>
              Erase permanently
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

const css = `
* { box-sizing:border-box; } body { margin:0; background:#F4F1EB; color:#2B2825; font-family:Inter,system-ui,sans-serif; } a { color:inherit; } :focus-visible { outline:2px solid #6E5420; outline-offset:2px; }
.enquiry-filters { display:grid; grid-template-columns:minmax(12rem,2fr) repeat(2,minmax(8rem,1fr)) auto; gap:.75rem; align-items:end; border-bottom:1px solid #C9BCA3; padding:0 0 1.25rem; } label { display:grid; gap:.35rem; font-size:.9rem; font-weight:600; } input,select,button { width:100%; min-height:44px; border:1px solid #C9BCA3; border-radius:0; padding:.6rem .7rem; background:transparent; color:inherit; font:inherit; } button { background:#2B2825; color:#F4F1EB; cursor:pointer; }
.enquiry-list { list-style:none; margin:1rem 0 0; padding:0; } .enquiry-list li { border-bottom:1px solid #C9BCA3; } .enquiry-link { display:grid; grid-template-columns:1.4fr 1fr 1fr 1fr; gap:.4rem 1rem; padding:1rem .25rem; text-decoration:none; align-items:baseline; } .enquiry-link strong { font-family:Fraunces,Georgia,serif; font-size:1.15rem; } .enquiry-link span { color:#5B544A; font-size:.9rem; } .handled { color:#496045 !important; } .unhandled { color:#8C3A2A !important; } .notice { border-inline-start:3px solid #8C3A2A; padding:.75rem; } .empty { padding:2rem 0; } .pagination { padding:1rem 0; color:#5B544A; }
.detail-header { display:flex; justify-content:space-between; align-items:start; gap:1rem; border-bottom:1px solid #C9BCA3; padding-bottom:1rem; } h1,h2 { font-family:Fraunces,Georgia,serif; font-weight:400; } h1 { margin:.2rem 0; font-size:clamp(2rem,5vw,3.5rem); } h2 { font-size:1.25rem; } .eyebrow { margin:0; color:#5B544A; font-size:.85rem; letter-spacing:.08em; } .badge { border:1px solid #6E5420; padding:.4rem .6rem; font-size:.85rem; } .erased { border-color:#8C3A2A; color:#8C3A2A; } .detail-grid,.fields { display:grid; grid-template-columns:repeat(3,1fr); gap:1rem; margin:1.5rem 0; } dt { color:#5B544A; font-size:.85rem; } dd { margin:.25rem 0 0; overflow-wrap:anywhere; } .detail-section { border-top:1px solid #C9BCA3; padding:1rem 0; } .message { white-space:pre-wrap; overflow-wrap:anywhere; } .gowns { list-style:none; padding:0; margin:0; } .gowns li { display:flex; justify-content:space-between; gap:1rem; padding:.7rem 0; border-bottom:1px solid #C9BCA3; }
.detail-actions { display:flex; flex-wrap:wrap; gap:.75rem; margin:1rem 0; } .detail-actions > button { width:auto; padding-inline:1rem; } .danger { background:#8C3A2A; border-color:#8C3A2A; color:#F4F1EB; } .field-error { color:#8C3A2A; margin:.35rem 0 0; } dialog { width:min(32rem, calc(100vw - 2rem)); border:1px solid #C9BCA3; background:#F4F1EB; color:inherit; padding:1.25rem; } dialog::backdrop { background:rgba(43,40,37,.5); } .erase-dialog ul { padding-inline-start:1.25rem; } .dialog-actions { display:flex; gap:.75rem; justify-content:flex-end; margin-top:1rem; } .dialog-actions button { width:auto; padding-inline:1rem; } .dialog-actions button[type=button] { background:transparent; color:inherit; }
@media (max-width: 44rem) { .enquiry-filters { grid-template-columns:1fr 1fr; } .enquiry-filters label:first-child { grid-column:1 / -1; } .enquiry-link { grid-template-columns:1fr 1fr; } .enquiry-link strong { grid-column:1 / -1; } .detail-grid,.fields { grid-template-columns:1fr 1fr; } }
@media (max-width: 30rem) { .enquiry-filters,.detail-grid,.fields { grid-template-columns:1fr; } .enquiry-filters label:first-child { grid-column:auto; } .enquiry-link { grid-template-columns:1fr; } .enquiry-link strong { grid-column:auto; } .detail-header { display:block; } .badge { display:inline-block; margin-top:.75rem; } }
@media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto !important; transition-duration:.01ms !important; animation-duration:.01ms !important; animation-iteration-count:1 !important; } }
`;
