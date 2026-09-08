import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function SessionDetail() {
  return (
    <div>
      <PageHeader title="SessionDetail" />
      <EmptyState icon={Construction} title="SessionDetail is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
