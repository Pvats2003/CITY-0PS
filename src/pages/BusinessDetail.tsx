import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function BusinessDetail() {
  return (
    <div>
      <PageHeader title="BusinessDetail" />
      <EmptyState icon={Construction} title="BusinessDetail is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
