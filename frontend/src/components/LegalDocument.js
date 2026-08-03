import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders a legal document, or a holding notice if it is not ready to publish.
 *
 * Server Component — ReactMarkdown runs at build time, so none of it reaches
 * the client bundle. Deliberately no Tailwind typography plugin (not installed);
 * element styles are supplied explicitly through `components`.
 *
 * `remark-gfm` is required, not optional: all three documents use pipe tables
 * for the pricing, sub-processor and retention sections, and without it those
 * render as unreadable runs of pipes.
 */
export default function LegalDocument({ doc }) {
  if (!doc) return null;

  if (!doc.ready) {
    return (
      <main className="mx-auto max-w-3xl px-5 py-16">
        <h1 className="text-2xl font-semibold text-gray-900">{doc.title}</h1>
        <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-5">
          <p className="text-sm text-amber-900">
            This document is being finalised and is not yet in force. Please
            contact us for a copy of the current terms before relying on
            anything here.
          </p>
        </div>
        {process.env.NODE_ENV !== 'production' && (
          <div className="mt-6 rounded-lg border border-red-300 bg-red-50 p-5 text-sm text-red-900">
            <p className="font-semibold">Developer note (hidden in production)</p>
            <p className="mt-2">
              {doc.reason === 'missing'
                ? 'Source markdown file could not be read.'
                : 'Unfilled placeholders remain, so the document will not publish:'}
            </p>
            {doc.placeholders?.length > 0 && (
              <ul className="mt-2 list-disc pl-5 font-mono text-xs">
                {doc.placeholders.map(p => <li key={p}>{p}</li>)}
              </ul>
            )}
          </div>
        )}
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <article className="text-[15px] leading-relaxed text-gray-800">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: p => <h1 className="mb-6 text-3xl font-semibold text-gray-900" {...p} />,
            h2: p => <h2 className="mb-3 mt-10 border-b pb-2 text-xl font-semibold text-gray-900" {...p} />,
            h3: p => <h3 className="mb-2 mt-6 text-base font-semibold text-gray-900" {...p} />,
            p: p => <p className="my-4" {...p} />,
            ul: p => <ul className="my-4 list-disc space-y-1 pl-6" {...p} />,
            ol: p => <ol className="my-4 list-decimal space-y-1 pl-6" {...p} />,
            a: p => <a className="text-blue-600 underline" {...p} />,
            strong: p => <strong className="font-semibold text-gray-900" {...p} />,
            blockquote: p => (
              <blockquote className="my-4 border-l-4 border-gray-300 bg-gray-50 py-2 pl-4 text-gray-700" {...p} />
            ),
            hr: () => <hr className="my-10 border-gray-200" />,
            code: p => <code className="rounded bg-gray-100 px-1 py-0.5 text-[13px]" {...p} />,
            // Tables carry the pricing, sub-processor and retention detail and
            // are the widest content here, so they scroll inside their own
            // container rather than forcing the page to scroll sideways on a
            // phone — which is how most of this will be read.
            table: p => (
              <div className="my-6 overflow-x-auto">
                <table className="w-full border-collapse text-sm" {...p} />
              </div>
            ),
            th: p => <th className="border-b-2 border-gray-300 px-3 py-2 text-left font-semibold" {...p} />,
            td: p => <td className="border-b border-gray-200 px-3 py-2 align-top" {...p} />,
          }}
        >
          {doc.content}
        </ReactMarkdown>
      </article>
    </main>
  );
}
