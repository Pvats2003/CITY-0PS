import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function Analytics() {
  return (
    <div>
      <PageHeader title="Analytics" />
      <EmptyState icon={Construction} title="Analytics is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
