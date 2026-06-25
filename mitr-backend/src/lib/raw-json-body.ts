import type { FastifyInstance } from 'fastify';

export const registerRawJsonBodyParser = (app: FastifyInstance): void => {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const rawBody = body.toString('utf8');
    if (request.url.startsWith('/checkout/webhooks/razorpay')) {
      request.rawBody = rawBody;
    }
    try {
      done(null, rawBody.length > 0 ? JSON.parse(rawBody) : null);
    } catch (error) {
      done(error as Error);
    }
  });
};
