"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import { readApiError, readCsrfToken } from "./CategoryForm";
import styles from "./SettingsForm.module.css";

export type AdminSettingsForm = {
  lead_time_comfortable_weeks: number;
  lead_time_rush_floor_weeks: number;
  lead_time_notice_copy: {
    comfortable: string;
    rush: string;
    in_stock_only: string;
  };
  studio_timezone: string;
  studio_facebook_page: string;
  studio_whatsapp_number: string;
  studio_viber_number: string;
};

export type NoticeBand = keyof AdminSettingsForm["lead_time_notice_copy"];

export function validateSettingsForm(value: AdminSettingsForm): string | null {
  if (!Number.isInteger(value.lead_time_comfortable_weeks) || value.lead_time_comfortable_weeks < 1 || value.lead_time_comfortable_weeks > 260)
    return "Comfortable lead time must be between 1 and 260 weeks.";
  if (!Number.isInteger(value.lead_time_rush_floor_weeks) || value.lead_time_rush_floor_weeks < 1 || value.lead_time_rush_floor_weeks > 260)
    return "Rush floor must be between 1 and 260 weeks.";
  if (value.lead_time_rush_floor_weeks >= value.lead_time_comfortable_weeks)
    return "Rush floor must be less than comfortable lead time.";
  if (Object.values(value.lead_time_notice_copy).some((copy) => !copy.trim()))
    return "Each notice needs copy.";
  if (!value.studio_timezone.trim()) return "Studio timezone is required.";
  return null;
}

const BAND_LABELS: Record<NoticeBand, string> = {
  comfortable: "Comfortable window",
  rush: "Rush window",
  in_stock_only: "In-stock only",
};

export default function SettingsForm({ initial }: { initial: AdminSettingsForm }) {
  const [value, setValue] = useState(initial);
  const [band, setBand] = useState<NoticeBand>("rush");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(() => value.lead_time_notice_copy[band], [band, value.lead_time_notice_copy]);

  function update<K extends keyof AdminSettingsForm>(key: K, next: AdminSettingsForm[K]) {
    setValue((current) => ({ ...current, [key]: next }));
  }

  function updateNotice(next: string) {
    setValue((current) => ({
      ...current,
      lead_time_notice_copy: { ...current.lead_time_notice_copy, [band]: next },
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    const validationError = validateSettingsForm(value);
    if (validationError) {
      setError(validationError);
      return;
    }
    setPending(true);
    try {
      const csrf = readCsrfToken();
      const response = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
        body: JSON.stringify(value),
      });
      if (!response.ok) {
        setError((await readApiError(response)).message);
        return;
      }
      setValue((await response.json()) as AdminSettingsForm);
      setMessage("Settings saved. New enquiry forms use these values on next load.");
    } catch {
      setError("Could not reach settings service. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Studio configuration</p>
          <h1>Settings</h1>
          <p className={styles.intro}>Keep lead times and contact hand-offs accurate without a deploy.</p>
        </div>
        <button className={styles.saveTop} type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </button>
      </div>

      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {message ? <p className={styles.success} role="status">{message}</p> : null}

      <section className={styles.section} aria-labelledby="lead-time-heading">
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>01 · Lead time</p>
          <h2 id="lead-time-heading">What can the workroom promise?</h2>
          <p>These windows guide the notice shown on the enquiry form.</p>
        </div>
        <div className={styles.gridTwo}>
          <label className={styles.field}>
            Comfortable window <span className={styles.hint}>weeks</span>
            <input type="number" min={1} max={260} value={value.lead_time_comfortable_weeks} onChange={(event) => update("lead_time_comfortable_weeks", Number(event.target.value))} />
          </label>
          <label className={styles.field}>
            Rush floor <span className={styles.hint}>weeks</span>
            <input type="number" min={1} max={260} value={value.lead_time_rush_floor_weeks} onChange={(event) => update("lead_time_rush_floor_weeks", Number(event.target.value))} />
          </label>
        </div>
        <label className={styles.field}>
          Studio timezone
          <input value={value.studio_timezone} onChange={(event) => update("studio_timezone", event.target.value)} placeholder="Asia/Manila" />
          <span className={styles.hint}>Use an IANA timezone, for example Asia/Manila.</span>
        </label>
      </section>

      <section className={styles.section} aria-labelledby="notice-heading">
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>02 · Notice copy</p>
          <h2 id="notice-heading">Give brides a clear next step</h2>
          <p>Copy is displayed as text. Mention an in-stock gown or rush order only when the studio can follow through.</p>
        </div>
        <div className={styles.noticeLayout}>
          <div className={styles.bandList} role="tablist" aria-label="Notice bands">
            {(Object.keys(BAND_LABELS) as NoticeBand[]).map((key) => (
              <button className={key === band ? styles.bandActive : styles.band} key={key} type="button" role="tab" aria-selected={key === band} onClick={() => setBand(key)}>
                <span>{BAND_LABELS[key]}</span>
                <span className={styles.bandArrow} aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
          <div className={styles.noticeEditor}>
            <label className={styles.field}>
              {BAND_LABELS[band]} notice
              <textarea value={value.lead_time_notice_copy[band]} onChange={(event) => updateNotice(event.target.value)} maxLength={2000} rows={5} />
              <span className={styles.hint}>{value.lead_time_notice_copy[band].length}/2000 characters</span>
            </label>
            <div className={styles.preview} aria-live="polite">
              <p className={styles.eyebrow}>Bride preview</p>
              <p>{preview}</p>
              {band === "in_stock_only" ? <Link href="/gowns?available=1">View available gowns</Link> : null}
            </div>
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="contact-heading">
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>03 · Contact hand-offs</p>
          <h2 id="contact-heading">Make it easy to reach the studio</h2>
          <p>These details build Messenger, WhatsApp and Viber links after an enquiry.</p>
        </div>
        <div className={styles.gridThree}>
          <label className={styles.field}>Messenger page handle<input value={value.studio_facebook_page} onChange={(event) => update("studio_facebook_page", event.target.value)} placeholder="klei.bridal" /></label>
          <label className={styles.field}>WhatsApp number<input inputMode="tel" value={value.studio_whatsapp_number} onChange={(event) => update("studio_whatsapp_number", event.target.value)} placeholder="639171234567" /></label>
          <label className={styles.field}>Viber number<input inputMode="tel" value={value.studio_viber_number} onChange={(event) => update("studio_viber_number", event.target.value)} placeholder="639171234567" /></label>
        </div>
      </section>

      <div className={styles.footer}><span>Changes take effect on the next enquiry form load.</span><button type="submit" disabled={pending}>{pending ? "Saving…" : "Save settings"}</button></div>
    </form>
  );
}
