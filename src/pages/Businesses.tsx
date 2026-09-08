import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function Businesses() {
  return (
    <div>
      <PageHeader title="Businesses" />
      <EmptyState icon={Construction} title="Businesses is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
