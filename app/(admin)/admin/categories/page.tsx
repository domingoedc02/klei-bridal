import Link from "next/link";

const categoryTypes = [
  ["silhouettes", "A-line, ball gown and more"],
  ["materials", "Satin, mikado, lace and more"],
  ["collections", "Minimalist, modern, lace and tulle"],
] as const;

export default function AdminCategoriesPage() {
  return (
    <main className="admin-page">
      <h1>Categories</h1>
      <p>Manage filters used across gown listings.</p>
      <nav aria-label="Category types">
        <ul>
          {categoryTypes.map(([type, description]) => (
            <li key={type}>
              <Link href={`/admin/categories/${type}`}>
                {type[0]?.toUpperCase() + type.slice(1)}
              </Link>{" "}
              — {description}
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
}
