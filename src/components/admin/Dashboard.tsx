"use client";

import { useEffect, useState } from "react";
import styles from "./Dashboard.module.css";

type Source = "social" | "search" | "direct" | "referral";
type Chat = "messenger" | "whatsapp" | "viber" | "none";

type Month = {
  month: string;
  enquiry_count: number;
  source_split: Record<Source, number>;
  chat_channel_split: Record<Chat, number>;
};

type DashboardResponse = {
  range: { from: string; to: string };
  months: Month[];
  send_my_list_sends: { available: boolean; count: number | null; reason: string };
  most_requested_gowns: { gown_id: string; gown_name: string; request_count: number }[];
  attribution_note: string;
  most_requested_note: string;
};

const SOURCE_LABELS: Record<Source, string> = {
  social: "Social",
  search: "Search",
  direct: "Direct",
  referral: "Referral",
};
const CHAT_LABELS: Record<Chat, string> = {
  messenger: "Messenger",
  whatsapp: "WhatsApp",
  viber: "Viber",
  none: "None",
};
const SOURCE_KEYS: Source[] = ["social", "search", "direct", "referral"];
const CHAT_KEYS: Chat[] = ["messenger", "whatsapp", "viber", "none"];

function monthLabel(month: string) {
  return new Intl.DateTimeFormat("en", { month: "short", year: "numeric" }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en").format(value);
}

function SplitTable({ title, months, keys, labels }: {
  title: string;
  months: Month[];
  keys: string[];
  labels: Record<string, string>;
}) {
  return (
    <section className={styles.panel} aria-labelledby={`${title.replaceAll(" ", "-")}-title`}>
      <h2 id={`${title.replaceAll(" ", "-")}-title`}>{title}</h2>
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <caption className={styles.srOnly}>{title} by month</caption>
          <thead><tr><th scope="col">Month</th>{keys.map((key) => <th scope="col" key={key}>{labels[key]}</th>)}</tr></thead>
          <tbody>{months.map((month) => {
            const values = title.startsWith("Source") ? month.source_split : month.chat_channel_split;
            return <tr key={month.month}><th scope="row">{monthLabel(month.month)}</th>{keys.map((key) => <td key={key}>{formatCount(values[key as keyof typeof values])}</td>)}</tr>;
          })}</tbody>
        </table>
      </div>
    </section>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/dashboard", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Dashboard data could not be loaded.");
        return (await response.json()) as DashboardResponse;
      })
      .then(setData)
      .catch((reason: unknown) => {
        if ((reason as { name?: string }).name !== "AbortError") setError("Dashboard data could not be loaded. Try again.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  if (loading) return <main className={styles.page} aria-busy="true"><p className={styles.muted}>Loading dashboard…</p></main>;
  if (error) return <main className={styles.page}><p className={styles.error} role="alert">{error}</p></main>;
  if (!data) return null;

  const latest = data.months.at(-1);
  const total = data.months.reduce((sum, month) => sum + month.enquiry_count, 0);
  const hasEnquiries = total > 0;
  const completeMonthCount = data.months.filter((month) => month.enquiry_count > 0).length;

  return (
    <main className={styles.page}>
      <header className={styles.header}><div><p className={styles.eyebrow}>Studio configuration</p><h1>Dashboard</h1><p className={styles.intro}>Enquiries and chat hand-offs, {monthLabel(data.range.from)} to {monthLabel(data.range.to)}.</p></div></header>
      {!hasEnquiries ? <section className={styles.empty} aria-labelledby="empty-title"><h2 id="empty-title">No enquiries yet</h2><p>Once brides submit an enquiry, monthly counts and channel splits appear here.</p></section> : <>
        {completeMonthCount < 2 && <p className={styles.note} role="note">Fewer than two complete months of enquiries. These first figures set your baseline; review them after month two.</p>}
        <section className={styles.kpis} aria-label="Dashboard summary">
          <article className={styles.kpi}><span>Current month enquiries</span><strong>{formatCount(latest?.enquiry_count ?? 0)}</strong></article>
          <article className={styles.kpi}><span>Send my list sends</span><strong>{data.send_my_list_sends.available && data.send_my_list_sends.count !== null ? formatCount(data.send_my_list_sends.count) : "Unavailable"}</strong><p>{data.send_my_list_sends.reason}</p></article>
        </section>
        <SplitTable title="Source split" months={data.months} keys={SOURCE_KEYS} labels={SOURCE_LABELS} />
        <SplitTable title="Chat-channel split" months={data.months} keys={CHAT_KEYS} labels={CHAT_LABELS} />
        <section className={styles.panel} aria-labelledby="requested-title"><h2 id="requested-title">Most requested gowns</h2><p className={styles.muted}>{data.most_requested_note}</p>{data.most_requested_gowns.length ? <ol className={styles.ranking}>{data.most_requested_gowns.map((gown) => <li key={gown.gown_id}><span>{gown.gown_name}</span><strong>{formatCount(gown.request_count)}</strong></li>)}</ol> : <p>No gown requests recorded.</p>}</section>
        <p className={styles.footerNote}>{data.attribution_note}</p>
      </>}
    </main>
  );
}
