using { my.orders } from '../db/schema';

service OrderService {

  @odata.draft.enabled
  @CollaborativeDraft.enabled: true
  entity Orders as projection on orders.Orders;

  entity OrderItems as projection on orders.OrderItems;
}

annotate OrderService with @requires: [
    'authenticated-user'
];
