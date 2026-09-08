import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function FOExecution() {
  return (
    <div>
      <PageHeader title="FOExecution" />
      <EmptyState icon={Construction} title="FOExecution is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
