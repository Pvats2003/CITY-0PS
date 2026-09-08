import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function Reports() {
  return (
    <div>
      <PageHeader title="Reports" />
      <EmptyState icon={Construction} title="Reports is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
