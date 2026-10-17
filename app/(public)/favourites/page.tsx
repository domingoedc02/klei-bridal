import { listCatalogue } from "@/server/services/catalogue";
import FavouritesView from "@/components/public/FavouritesView";
import { gownFilterQuerySchema } from "@/shared/schemas/gownFilters";

export const dynamic = "force-dynamic";

export default async function FavouritesPage() {
  const catalogue = await listCatalogue(gownFilterQuerySchema.parse({}));
  return (
    <FavouritesView
      gowns={catalogue.cards.map((card) => ({
        id: card.id,
        slug: card.slug,
        name: card.name,
        image: null,
      }))}
    />
  );
}
