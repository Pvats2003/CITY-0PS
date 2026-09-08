import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function Issues() {
  return (
    <div>
      <PageHeader title="Issues" />
      <EmptyState icon={Construction} title="Issues is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
