using OrderService as service from '../../srv/service';

annotate service.Orders with @(
  UI.LineItem: [
    { Value: OrderNo, Label: 'Order No' },
    { Value: Customer, Label: 'Customer' },
    { Value: Status, Label: 'Status' },
    { Value: NetAmount, Label: 'Net Amount' },
    { Value: Currency, Label: 'Currency' }
  ],
  UI.HeaderInfo: {
    TypeName: 'Order',
    TypeNamePlural: 'Orders',
    Title: { Value: OrderNo },
    Description: { Value: Customer }
  },
  UI.Identification: [
    { Value: OrderNo, Label: 'Order No' },
    { Value: Customer, Label: 'Customer' },
    { Value: Status, Label: 'Status' },
    { Value: NetAmount, Label: 'Net Amount' },
    { Value: Currency, Label: 'Currency' },
    { Value: Notes, Label: 'Notes' }
  ],
  UI.FieldGroup #GeneralInfo: {
    Label: 'General Information',
    Data: [
      { Value: OrderNo, Label: 'Order No' },
      { Value: Customer, Label: 'Customer' },
      { Value: Status, Label: 'Status' },
      { Value: Notes, Label: 'Notes' }
    ]
  },
  UI.FieldGroup #Financial: {
    Label: 'Financial Data',
    Data: [
      { Value: NetAmount, Label: 'Net Amount' },
      { Value: Currency, Label: 'Currency' }
    ]
  },
  UI.Facets: [
    {
      $Type: 'UI.ReferenceFacet',
      Label: 'General',
      Target: '@UI.FieldGroup#GeneralInfo'
    },
    {
      $Type: 'UI.ReferenceFacet',
      Label: 'Financial',
      Target: '@UI.FieldGroup#Financial'
    },
    {
      $Type: 'UI.ReferenceFacet',
      Label: 'Items',
      Target: 'Items/@UI.LineItem'
    }
  ]
);

annotate service.OrderItems with @(
  UI.LineItem: [
    { Value: ItemNo, Label: 'Item No' },
    { Value: Product, Label: 'Product' },
    { Value: Quantity, Label: 'Quantity' },
    { Value: Price, Label: 'Price' }
  ]
);