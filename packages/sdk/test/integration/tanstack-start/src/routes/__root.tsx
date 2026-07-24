import { Outlet, createRootRoute } from '@tanstack/react-router';

export const Route = createRootRoute({
  component: () => (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>pisama · TanStack Start integration</title>
      </head>
      <body>
        <Outlet />
      </body>
    </html>
  ),
});
