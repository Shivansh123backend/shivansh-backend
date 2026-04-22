import { Layout, PageHeader } from "@/components/layout";
import { Sparkles } from "lucide-react";

export default function ComingSoonPage({ title }: { title: string }) {
  return (
    <Layout>
      <PageHeader title={title} subtitle="Coming soon" />
      <div className="p-6">
        <div className="border border-dashed border-border rounded-lg bg-card p-16 flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <div className="text-center">
            <p className="text-base font-semibold text-foreground">{title}</p>
            <p className="text-xs text-muted-foreground mt-1">
              This module is in active development and will be available soon.
            </p>
          </div>
        </div>
      </div>
    </Layout>
  );
}
