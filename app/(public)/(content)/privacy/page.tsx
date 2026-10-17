import type { Metadata } from "next";
import { PRIVACY_NOTICE_VERSION } from "@/shared/privacy";

export const metadata: Metadata = { title: "Privacy notice" };

// KBS-30. Draft text for client approval. Plain language above the divider;
// the formal caveat sits in its own section below it. Change the text in
// substance => bump PRIVACY_NOTICE_VERSION in src/shared/privacy.ts.
export default function PrivacyPage() {
  return (
    <main className="privacy">
      <h1>Privacy notice</h1>
      <p>
        <small>Version {PRIVACY_NOTICE_VERSION}</small>
      </p>

      <section aria-labelledby="what-we-collect">
        <h2 id="what-we-collect">What we ask you for</h2>
        <p>
          When you send an enquiry we collect your name, your phone number, your email, your
          wedding date and the gowns you picked. You can also write us a message. We use these only
          to reply to you about your enquiry. We also note how you found us (for example, a search
          or a link), so the studio can see what is working.
        </p>
      </section>

      <section aria-labelledby="what-we-dont">
        <h2 id="what-we-dont">What we do not collect</h2>
        <ul>
          <li>No payment details. There is no cart and no checkout on this site.</li>
          <li>No accounts. You do not sign up to anything.</li>
          <li>
            Your favourites stay on your phone. The gowns you save, and the details we remember to
            save you retyping, live only in your own browser. They never reach our server. We only
            receive the gowns you choose to send in an enquiry.
          </li>
          <li>No advertising or tracking tools, so there is no cookie banner to click.</li>
        </ul>
      </section>

      <section aria-labelledby="how-long">
        <h2 id="how-long">How long we keep it</h2>
        <p>
          We keep your enquiry for as long as the studio runs. We have not set an end date. You can
          ask us to erase your details at any time (see &ldquo;Your rights&rdquo; below).
        </p>
      </section>

      <section aria-labelledby="who-sees">
        <h2 id="who-sees">Who can see it</h2>
        <p>
          Only the studio&rsquo;s own staff, each with a personal login. Every time a staff member
          opens an enquiry, the system writes it down. When we reply, your email goes through our
          email service, and a copy lands in the studio&rsquo;s inbox.
        </p>
      </section>

      <section aria-labelledby="where">
        <h2 id="where">Where it is stored</h2>
        <p>
          Your enquiry is stored on a Hostinger server in Singapore. If you live in the EU or the
          UK, that means your details are held outside your region. By ticking the box on the
          enquiry form you agree to this.
        </p>
      </section>

      <section aria-labelledby="rights">
        <h2 id="rights">Your rights</h2>
        <p>
          You can ask to see what we hold about you, and you can ask us to erase it. Contact the
          studio and quote the reference from your confirmation email. We will erase your name,
          phone number, email and message. We keep the wedding date and the gowns you chose, with
          nothing that says who you are, so the studio can count its enquiries.
        </p>
      </section>

      <hr />

      <section aria-labelledby="caveat" className="privacy-caveat">
        <h2 id="caveat">Important: status of this notice</h2>
        <p>
          This notice is the project team&rsquo;s good-faith draft. It is not legal advice, and the
          team are not the studio&rsquo;s lawyers. Because the studio takes enquiries from brides in
          the EU and the UK, their data may warrant professional legal review before the studio
          relies on this text.
        </p>
      </section>
    </main>
  );
}
