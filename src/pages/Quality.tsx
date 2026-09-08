import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function Quality() {
  return (
    <div>
      <PageHeader title="Quality" />
      <EmptyState icon={Construction} title="Quality is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
