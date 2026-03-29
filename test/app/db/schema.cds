namespace my.orders;

using { managed, cuid } from '@sap/cds/common';

@CollaborativeDraft.enabled: true
@odata.draft.enabled
entity Orders : managed {
  key ID        : UUID;
  OrderNo       : String(20) @mandatory;
  Customer      : String(100) @mandatory;
  Status        : String(20) default 'Open';
  NetAmount     : Decimal(15,2);
  Currency      : String(3) default 'EUR';
  Notes         : String(500);
  Items         : Composition of many OrderItems on Items.Order = $self;
}

entity OrderItems : cuid {
  Order         : Association to Orders;
  ItemNo        : Integer;
  Product       : String(100) @mandatory;
  Quantity      : Integer default 1;
  Price         : Decimal(15,2);
}
