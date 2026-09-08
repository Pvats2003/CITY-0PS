import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function FieldOfficers() {
  return (
    <div>
      <PageHeader title="FieldOfficers" />
      <EmptyState icon={Construction} title="FieldOfficers is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
