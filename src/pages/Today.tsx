import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function Today() {
  return (
    <div>
      <PageHeader title="Today" />
      <EmptyState icon={Construction} title="Today is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
