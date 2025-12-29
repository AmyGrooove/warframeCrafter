import { Ubuntu } from 'next/font/google'

import { IRootLayoutProps } from '../types/IRootLayoutProps'

import st from './RootLayout.module.scss'
import { useRootLayout } from './useRootLayout'
import { Providers } from './Providers'

const ubuntu = Ubuntu({
  weight: ['400', '700'],
  subsets: ['latin'],
  display: 'swap',
})

const RootLayout = (props: IRootLayoutProps) => {
  const { children, dehydratedState } = useRootLayout(props)

  return (
    <html lang="ru">
      <body className={ubuntu.className}>
        <Providers dehydratedState={dehydratedState}>
          <main className={st.main}>{children}</main>
        </Providers>
      </body>
    </html>
  )
}

export { RootLayout }
