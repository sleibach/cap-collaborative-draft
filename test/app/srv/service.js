'use strict'

const cds = require('@sap/cds')
const { SHARE_INVITE_EVENT } = require('cap-collaborative-draft/dist/lib/draft-handlers')

const LOG = cds.log('orders')

class OrderService extends cds.ApplicationService {
  async init() {
    cds.on(SHARE_INVITE_EVENT, ({ draftUUID, invitedBy, users }) => {
      const userList = users.map(u => u.UserID).join(', ')
      LOG.info(`Invite received: ${invitedBy} invited [${userList}] to draft ${draftUUID}`)
      // TODO: send email, push notification, etc.
    })

    return super.init()
  }
}

module.exports = { OrderService }
