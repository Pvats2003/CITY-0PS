import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function IssueDetail() {
  return (
    <div>
      <PageHeader title="IssueDetail" />
      <EmptyState icon={Construction} title="IssueDetail is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
