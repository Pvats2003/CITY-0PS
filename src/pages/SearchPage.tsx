import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function SearchPage() {
  return (
    <div>
      <PageHeader title="SearchPage" />
      <EmptyState icon={Construction} title="SearchPage is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
