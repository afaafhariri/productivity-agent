import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Model replies as Markdown. Links open in the OS browser (main denies new windows). */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
