"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  getContactDetails,
  getFavouriteIds,
  removeFavourite,
  type ContactDetails,
} from "@/client/favourites/storage";

const emptyContact: ContactDetails = { firstName: "", lastName: "", contactNumber: "", email: "" };

function csrfToken(): string | undefined {
  try {
    return document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("kbs_csrf="))
      ?.slice(9);
  } catch {
    return undefined;
  }
}

export default function EnquiryForm() {
  const [contact, setContact] = useState<ContactDetails>(emptyContact);
  const [gowns, setGowns] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const dateRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setContact(getContactDetails());
    setGowns(getFavouriteIds());
  }, []);

  function updateContact(key: keyof ContactDetails, value: string) {
    setContact((current) => ({ ...current, [key]: value }));
  }

  function onDateChange(value: string) {
    setNotice(null);
    if (!value) return;
    const today = new Date();
    const date = new Date(`${value}T12:00:00`);
    const weeks =
      (date.getTime() -
        new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      604800000;
    if (weeks < 13)
      setNotice(
        "Your date is close. In-stock gowns and rush orders may both be options — view gowns available now.",
      );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    if (!values.wedding_date) {
      setError("Wedding date is required.");
      dateRef.current?.focus();
      return;
    }
    setError(null);
    setPending(true);
    try {
      const response = await fetch("/api/enquiries", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(csrfToken() ? { "x-csrf-token": csrfToken()! } : {}),
        },
        body: JSON.stringify({
          first_name: values.first_name,
          last_name: values.last_name,
          contact_number: values.contact_number,
          email: values.email,
          wedding_date: values.wedding_date,
          message: values.message || undefined,
          gown_ids: gowns,
        }),
      });
      if (!response.ok)
        throw new Error("We could not send your enquiry. Please check your details and try again.");
      try {
        window.localStorage.setItem(
          "kbs.contact.v1",
          JSON.stringify({
            firstName: values.first_name,
            lastName: values.last_name,
            contactNumber: values.contact_number,
            email: values.email,
          }),
        );
      } catch {
        /* blocked storage must not block submission */
      }
      setSent(true);
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "We could not send your enquiry. Please try again.",
      );
    } finally {
      setPending(false);
    }
  }

  if (sent)
    return (
      <section className="enquiry-success" aria-live="polite">
        <h1>Thank you</h1>
        <p>Your enquiry was sent. We will be in touch soon.</p>
      </section>
    );

  return (
    <form
      className="enquiry-form"
      method="post"
      action="/api/enquiries"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <fieldset>
        <legend>Your details</legend>
        <div className="fields">
          <label>
            First name
            <input
              name="first_name"
              autoComplete="given-name"
              value={contact.firstName}
              onChange={(e) => updateContact("firstName", e.target.value)}
              required
              maxLength={100}
            />
          </label>
          <label>
            Last name
            <input
              name="last_name"
              autoComplete="family-name"
              value={contact.lastName}
              onChange={(e) => updateContact("lastName", e.target.value)}
              required
              maxLength={100}
            />
          </label>
          <label>
            Contact number
            <input
              name="contact_number"
              type="tel"
              autoComplete="tel"
              value={contact.contactNumber}
              onChange={(e) => updateContact("contactNumber", e.target.value)}
              required
              maxLength={100}
            />
          </label>
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="email"
              value={contact.email}
              onChange={(e) => updateContact("email", e.target.value)}
              required
              maxLength={254}
            />
          </label>
          <label className="wide">
            Wedding date <span>(required)</span>
            <input
              ref={dateRef}
              name="wedding_date"
              type="date"
              onChange={(e) => onDateChange(e.target.value)}
              required
              aria-describedby={error ? "form-error" : undefined}
            />
          </label>
          <label className="wide">
            Message <span>(optional)</span>
            <textarea name="message" rows={5} maxLength={2000} />
          </label>
        </div>
      </fieldset>
      <section aria-labelledby="selected-heading" className="selected">
        <h2 id="selected-heading">Gowns you selected</h2>
        {gowns.length ? (
          <ul>
            {gowns.map((id) => (
              <li key={id}>
                <span className="gown-thumb" aria-hidden="true" /> <span>{id}</span>
                <button
                  type="button"
                  onClick={() => {
                    removeFavourite(id);
                    setGowns((current) => current.filter((gown) => gown !== id));
                  }}
                  aria-label={`Remove gown ${id}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>No gown selected yet. You can still send an enquiry.</p>
        )}
      </section>
      {notice ? (
        <aside className="lead-notice" aria-live="polite">
          <strong>Planning a close date?</strong> {notice}{" "}
          <Link href="/gowns?available_now=true">View gowns available now</Link>
        </aside>
      ) : null}
      {error ? (
        <p className="form-error" id="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="submit" type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send enquiry"}
      </button>
      <p className="nojs">
        This form works with JavaScript disabled. Complete the fields above and select Send enquiry.
      </p>
      <style jsx>{`
        .enquiry-form {
          max-width: 52rem;
          margin: 0 auto;
          padding: 1.5rem;
          color: #2b2825;
        }
        fieldset {
          border: 1px solid #c9bca3;
          padding: clamp(1rem, 3vw, 2rem);
        }
        legend,
        h1,
        h2 {
          font-family: Fraunces, Georgia, serif;
          font-weight: 500;
        }
        legend {
          font-size: 1.5rem;
          padding: 0 0.5rem;
        }
        .fields {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 1rem;
        }
        label {
          display: grid;
          gap: 0.4rem;
          font-weight: 600;
        }
        label span {
          font-weight: 400;
          color: #5b544a;
          font-size: 0.875rem;
        }
        .wide {
          grid-column: 1 / -1;
        }
        input,
        textarea {
          border: 1px solid #8c857a;
          border-radius: 0;
          padding: 0.75rem;
          font: inherit;
          background: #fffdf9;
          color: inherit;
          min-height: 2.75rem;
        }
        textarea {
          resize: vertical;
        }
        .selected {
          margin: 2rem 0;
        }
        .selected h2 {
          font-size: 1.35rem;
        }
        ul {
          list-style: none;
          padding: 0;
          display: grid;
          gap: 0.5rem;
        }
        li {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          border-bottom: 1px solid #c9bca3;
          padding: 0.5rem 0;
        }
        li button {
          margin-left: auto;
        }
        .gown-thumb {
          width: 2.75rem;
          height: 4rem;
          background: #ded5c8;
          display: inline-block;
        }
        button,
        .submit {
          min-height: 2.75rem;
          border: 1px solid #6e5420;
          border-radius: 0;
          padding: 0.55rem 1rem;
          background: transparent;
          color: #2b2825;
          font: inherit;
          cursor: pointer;
        }
        .submit {
          width: 100%;
          background: #2b2825;
          color: #fffdf9;
        }
        button:focus-visible,
        a:focus-visible,
        input:focus-visible,
        textarea:focus-visible {
          outline: 2px solid #6e5420;
          outline-offset: 2px;
        }
        .lead-notice {
          border-left: 3px solid #6e5420;
          padding: 1rem;
          margin: 1rem 0;
          background: #eee8dd;
        }
        .lead-notice a {
          color: #2b2825;
          font-weight: 700;
        }
        .form-error {
          color: #8c3a2a;
          font-weight: 700;
        }
        .nojs {
          color: #5b544a;
          font-size: 0.875rem;
        }
        .enquiry-success {
          max-width: 52rem;
          margin: 0 auto;
          padding: 2rem 1.5rem;
        }
        @media (max-width: 600px) {
          .fields {
            grid-template-columns: 1fr;
          }
          .wide {
            grid-column: auto;
          }
          .enquiry-form {
            padding: 1rem;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          * {
            scroll-behavior: auto !important;
            transition: none !important;
          }
        }
      `}</style>
    </form>
  );
}
