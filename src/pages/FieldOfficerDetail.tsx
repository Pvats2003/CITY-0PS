import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function FieldOfficerDetail() {
  return (
    <div>
      <PageHeader title="FieldOfficerDetail" />
      <EmptyState icon={Construction} title="FieldOfficerDetail is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
