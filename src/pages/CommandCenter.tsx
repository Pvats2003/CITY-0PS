import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function CommandCenter() {
  return (
    <div>
      <PageHeader title="CommandCenter" />
      <EmptyState icon={Construction} title="CommandCenter is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
