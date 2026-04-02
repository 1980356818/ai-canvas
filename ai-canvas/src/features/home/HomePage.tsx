import AIPromptInput from "@/features/home/AIPromptInput";
import WorkflowGrid from "@/features/home/WorkflowGrid";

export default function HomePage() {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-background">
      <div className="flex flex-col items-center justify-center px-6 py-16">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-2xl font-bold text-foreground">AI 无限画布</span>
        </div>
        <p className="mb-10 text-sm text-muted-foreground">
          告诉我你想创作什么，一键生成画布工作流
        </p>

        <AIPromptInput />
      </div>

      <div className="border-t border-border" />

      <div className="flex-1 px-6 py-8">
        <WorkflowGrid />
      </div>
    </div>
  );
}
