import { memo, useCallback, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface MarkdownContentProps {
  content: string;
  className?: string;
  compact?: boolean;
}

function CodeBlock({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"code"> & { node?: unknown }) {
  const { node: _, ...rest } = props;
  const isInline = !className;
  const lang = className?.replace("language-", "") ?? "";

  if (isInline) {
    return (
      <code
        className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono text-foreground"
        {...rest}
      >
        {children}
      </code>
    );
  }

  return <CodeFence lang={lang}>{children}</CodeFence>;
}

function CodeFence({
  lang,
  children,
}: {
  lang: string;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const text =
      typeof children === "string"
        ? children
        : String(children).replace(/\n$/, "");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [children]);

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-border bg-muted/50">
      {lang && (
        <div className="flex items-center justify-between border-b border-border bg-muted/80 px-3 py-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {lang}
          </span>
        </div>
      )}
      <button
        onClick={handleCopy}
        className={cn(
          "absolute top-1.5 right-2 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-all",
          "opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100",
          lang && "top-[calc(1.5rem+8px)]",
        )}
        title="复制"
      >
        {copied ? (
          <Check className="h-3 w-3 text-emerald-500" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </button>
      <pre className="overflow-x-auto p-3">
        <code className="text-[0.8rem] leading-relaxed font-mono">
          {children}
        </code>
      </pre>
    </div>
  );
}

const components = {
  code: CodeBlock,
  p: ({ children, node: _, ...props }: ComponentPropsWithoutRef<"p"> & { node?: unknown }) => (
    <p className="mb-2 last:mb-0 leading-relaxed" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, node: _, ...props }: ComponentPropsWithoutRef<"ul"> & { node?: unknown }) => (
    <ul className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, node: _, ...props }: ComponentPropsWithoutRef<"ol"> & { node?: unknown }) => (
    <ol className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, node: _, ...props }: ComponentPropsWithoutRef<"li"> & { node?: unknown }) => (
    <li className="leading-relaxed" {...props}>
      {children}
    </li>
  ),
  h1: ({ children, node: _, ...props }: ComponentPropsWithoutRef<"h1"> & { node?: unknown }) => (
    <h1 className="mt-4 mb-2 text-lg font-bold first:mt-0" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, node: _, ...props }: ComponentPropsWithoutRef<"h2"> & { node?: unknown }) => (
    <h2 className="mt-3 mb-2 text-base font-bold first:mt-0" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, node: _, ...props }: ComponentPropsWithoutRef<"h3"> & { node?: unknown }) => (
    <h3 className="mt-3 mb-1.5 text-sm font-bold first:mt-0" {...props}>
      {children}
    </h3>
  ),
  blockquote: ({ children, node: _, ...props }: ComponentPropsWithoutRef<"blockquote"> & { node?: unknown }) => (
    <blockquote
      className="my-2 border-l-2 border-primary/40 pl-3 text-muted-foreground italic"
      {...props}
    >
      {children}
    </blockquote>
  ),
  table: ({ children, node: _, ...props }: ComponentPropsWithoutRef<"table"> & { node?: unknown }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, node: _, ...props }: ComponentPropsWithoutRef<"th"> & { node?: unknown }) => (
    <th
      className="border border-border bg-muted px-2 py-1 text-left font-semibold"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, node: _, ...props }: ComponentPropsWithoutRef<"td"> & { node?: unknown }) => (
    <td className="border border-border px-2 py-1" {...props}>
      {children}
    </td>
  ),
  a: ({ children, href, node: _, ...props }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) => (
    <a
      href={href}
      className="text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  hr: ({ node: _, ...props }: ComponentPropsWithoutRef<"hr"> & { node?: unknown }) => (
    <hr className="my-3 border-border" {...props} />
  ),
};

export default memo(function MarkdownContent({
  content,
  className,
  compact,
}: MarkdownContentProps) {
  if (!content) return null;

  return (
    <div className={cn("text-sm overflow-hidden [overflow-wrap:anywhere]", compact && "text-xs", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
