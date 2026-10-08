import Link from "next/link";
import { notFound } from "next/navigation";
import CategoryList from "@/components/admin/CategoryList";

type CategoryType = "silhouettes" | "materials" | "collections";
const types: CategoryType[] = ["silhouettes", "materials", "collections"];

export default async function AdminCategoryTypePage({
  params,
}: {
  params: Promise<{ type: string }>;
}) {
  const { type } = await params;
  if (!types.includes(type as CategoryType)) notFound();
  return (
    <main className="admin-page">
      <p>
        <Link href="/admin/categories">Categories</Link>
      </p>
      <h1>{type[0]?.toUpperCase() + type.slice(1)}</h1>
      <CategoryList type={type as CategoryType} />
      <style>{`
        :root { --page:#F4F1EB; --ink:#2B2825; --muted:#5B544A; --line:#C9BCA3; --gold:#6E5420; --error:#8C3A2A; }
        * { box-sizing:border-box; } body { margin:0; background:var(--page); color:var(--ink); font-family:Inter,system-ui,sans-serif; } .admin-page { max-width:72rem; margin:0 auto; padding:clamp(1rem,4vw,3rem); } h1,h2 { font-family:Georgia,serif; font-weight:400; } h1 { font-size:clamp(2rem,5vw,3.5rem); } .category-form { border-block:1px solid var(--line); padding:1rem 0; } label { display:block; margin-bottom:.4rem; } input,select,button { min-height:44px; border:1px solid var(--line); border-radius:0; background:transparent; color:inherit; font:inherit; padding:.6rem .75rem; } button { cursor:pointer; } button:disabled { cursor:not-allowed; opacity:.5; } :focus-visible { outline:2px solid var(--gold); outline-offset:2px; } .form-row { display:flex; gap:.5rem; flex-wrap:wrap; } .form-row input { flex:1 1 14rem; } .form-error { color:var(--error); } .text-button { border:0; padding-inline:0; text-decoration:underline; color:inherit; min-height:44px; } .notice { border-inline-start:3px solid var(--gold); padding:.75rem; } .category-list { list-style:none; padding:0; margin:1.5rem 0; } .category-list li { display:flex; gap:1rem; align-items:center; justify-content:space-between; flex-wrap:wrap; border-bottom:1px solid var(--line); padding:1rem 0; } .category-value { display:flex; gap:1rem; align-items:baseline; flex-wrap:wrap; } .category-value span:last-child { color:var(--muted); font-size:.9rem; } .category-actions { display:flex; gap:.5rem; flex-wrap:wrap; } dialog { border:1px solid var(--ink); border-radius:0; background:var(--page); color:var(--ink); max-width:calc(100% - 2rem); width:28rem; padding:1.5rem; } dialog::backdrop { background:#2B282580; } .dialog-actions { display:flex; justify-content:flex-end; gap:.5rem; margin-top:1.5rem; } .merge-dialog select { width:100%; } .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; } @media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto !important; transition-duration:.01ms !important; animation-duration:.01ms !important; animation-iteration-count:1 !important; } } @media (max-width:30rem) { .category-actions { width:100%; } .category-actions button { flex:1 1 30%; } }
      `}</style>
    </main>
  );
}
