import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function Sessions() {
  return (
    <div>
      <PageHeader title="Sessions" />
      <EmptyState icon={Construction} title="Sessions is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
