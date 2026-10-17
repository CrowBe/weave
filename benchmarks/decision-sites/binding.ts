/** One replay identity for dispatch and non-executing report reconstruction. */
import { digest } from './journal.ts';
import type { Item, Provider, Request } from './types.ts';

export function bindingFor(provider:Provider,entry:{item:Pick<Item,'site'|'id'>;set_digest:string},request:Request,serialized=provider.serialize(request)) {
 return {provider:provider.id,model:provider.model,site:entry.item.site,item_id:entry.item.id,
  set_digest:entry.set_digest,question_digest:digest(JSON.stringify(request)),request_digest:digest(serialized)};
}
