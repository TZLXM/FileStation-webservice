import { INestApplication } from '@nestjs/common';
import { json, NextFunction, Request, Response, RequestHandler, urlencoded } from 'express';

export const MCP_ROUTE_PATH = '/api/v1/mcp';

/**
 * Keep Nest's normal 100KB JSON/urlencoded limits for every route except MCP.
 * MCP is deliberately left unread so its controller can decide 404/auth first,
 * then parse an authenticated POST with its dedicated 16MB limit.
 */
export function installNonMcpBodyParsers(app: INestApplication): void {
  const skipMcp = (parser: RequestHandler) =>
    function nonMcpBodyParser(req: Request, res: Response, next: NextFunction) {
      if (req.path.replace(/\/+$/, '') === MCP_ROUTE_PATH) return next();
      return parser(req, res, next);
    };

  app.use(skipMcp(json()));
  app.use(skipMcp(urlencoded({ extended: true })));
}
