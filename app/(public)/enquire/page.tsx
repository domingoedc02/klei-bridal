import type { Metadata } from "next";
import EnquiryForm from "@/components/public/EnquiryForm";

export const metadata: Metadata = { title: "Enquire" };

export default function EnquirePage() {
  return (
    <main>
      <EnquiryForm />
    </main>
  );
}
