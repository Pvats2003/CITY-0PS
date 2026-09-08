import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Construction } from "lucide-react";

export default function Settings() {
  return (
    <div>
      <PageHeader title="Settings" />
      <EmptyState icon={Construction} title="Settings is under construction" description="This screen will be built in a later step." />
    </div>
  );
}
