/**
 * An Ember Data Adapter written to use Parse REST API
 * @type {DS.RESTAdapter}
 */
var ParseAdapter = DS.ParseAdapter = DS.RESTAdapter.extend({

  defaultSerializer: '_parse',

  init: function(){
    this._super();
    this.set('headers', {
      "X-Parse-Application-Id": this.get('applicationId'),
      "X-Parse-REST-API-Key": this.get('restApiId')
    });
  },

  host: "https://api.parse.com",
  namespace: '1',
  classesPath: 'classes',

  pathForType: function(type) {
    var factory = this.container.lookupFactory('model:' + type);
    if(DS.ParseUserModel.detect(factory)){
      return "users";
    } else if(type === "login") {
      return type;
    } else {
      return this.classesPath + '/' + factory.parseClassName();
    }
  }

}); 


/*
  Serializer to assure proper Parse-to-Ember encodings
*/
var ParseSerializer = DS.ParseSerializer = DS.RESTSerializer.extend({

  primaryKey: "objectId",

  /**
   * Because Parse only returns the updatedAt/createdAt values on updates
   * we have to intercept it here to assure that the adapter knows which 
   * record ID we are dealing with (using the primaryKey).
   */
  extract: function(store, type, payload, id, requestType){
    if(id !== null && requestType === "updateRecord"){
      payload[this.get('primaryKey')] = id;
    }
    return this._super(store, type, payload, id, requestType);
  },

  normalizeAttributes: function(type, hash){
    type.eachAttribute(function(key, meta){
      if(meta.type === "date" && Ember.typeOf(hash[key]) === "object"){
        hash[key] = hash[key].iso;
      } else if(meta.type === "date" && Ember.typeOf(hash[key]) === "string"){
        hash[key] = new Date(hash[key]).toISOString();
      }
    });
    this._super(type, hash);
  },

  normalizeRelationships: function(type, hash){
    this._super(type, hash);
    type.eachRelationship(function(key, relationship) {
      if(hash[key] && relationship.kind === 'belongsTo'){
        hash[key] = hash[key].objectId;
      }
      if(relationship.kind === 'hasMany'){ 
        var query = {
          where: {
            "$relatedTo": {
              "object": {
                "__type": "Pointer",
                "className": Ember.String.capitalize(type.parseClassName()),
                "objectId": hash.id
              },
              key: key
            }
          }
        };
        hash[key] = this.get('store').findQuery(Ember.String.singularize(key), query); 
      }
    }, this);
  },

  normalizePayload: function(type, payload){
    var result = {};
    if(payload.results){
      result[type.typeKey] = payload.results;
    } else {
      result[type.typeKey] = payload;
    }
    return result;
  },

  serializeIntoHash: function(hash, type, record, options){
    Ember.merge(hash, this.serialize(record, options));
  },

  serializeAttribute: function(record, json, key, attribute) {
    if(key === 'createdAt' || key === 'updatedAt' || key === 'emailVerified'){
      delete json[key];
    } else if(attribute.type === "date" && key !== 'createdAt' && key !== 'updatedAt'){
      json[key] = { 
        "__type": "Date", 
        iso: record.get(key) 
      };
    } else {
      this._super(record, json, key, attribute);
    }
  },

  serializeBelongsTo: function(record, json, relationship){
    var key = relationship.key;
    var belongsTo = record.get(key);
    if(belongsTo){
      var className = belongsTo.parseClassName();
      json[key] = {
        "__type": "Pointer", 
        "className": className, 
        "objectId": belongsTo.get('id') 
      };
    }
  },

  serializeHasMany: function(record, json, relationship){
    //TODO: Need to assure relations is handled.
  }

});

/**
 * Setup the Parse Serializer to be available as default for Parse Adapter.
 */
Ember.onLoad('Ember.Application', function(Application) {
  Application.initializer({
    name: "parse",
    initialize: function(container, application) {
      application.register('serializer:_parse', DS.ParseSerializer);
    }
  });
});

/**
 * Model to setup default Parse attributes like create/update date
 * fields.
 */
var ParseModel = DS.ParseModel = DS.Model.extend({
  createdAt: DS.attr('date'),
  updatedAt: DS.attr('date'),

  parseClassName: function(){
    return this.constructor.parseClassName();
  },

  adapterDidCommit: function(data){
    Ember.merge(this._data, data);
    this._super(this._data);
  }
});

ParseModel.reopenClass({
  parseClassName: function(){
    return Ember.String.capitalize(this.typeKey);
  }
});

var ParseUserModel = DS.ParseUserModel = ParseModel.extend({
  username: DS.attr('string'),
  password: DS.attr('string'),
  email: DS.attr('string'),
  emailVerified: DS.attr('boolean'),
  sessionToken: DS.attr('string'),

  isCurrent: Ember.computed.bool('currentUser'),
  
  _persist: function(data){
    var instance = this;
    //TODO: this.get('store').adapterFor(this.constructor);
    var adapter = this.get('store').get('defaultAdapter');
    var headers = adapter.get('headers');
    if(data){
      data.id = data.objectId;
      instance.setProperties(data);
      instance.transitionTo('isLoaded');
      headers["X-Parse-Session-Token"] = data.sessionToken;
      adapter.set('headers', headers);
    }
    if(typeof(localStorage) !== undefined){
      if(!data){
        this.set('currentUser', false);
        localStorage.removeItem("ember_parse_user");    
      } else {
        this.set('currentUser', true);
        var local = { session: data.sessionToken, userId: data.objectId };
        localStorage.setItem("ember_parse_user", JSON.stringify(local));  
      }
    }
  },

  /**
   * Sign up functionality. The afterSignUp callback will be called
   * with a data object that either has the sign up details
   * (session token, username, objectId) or the error details.
   * Error details are the same as the Parse REST API error details.
   */
  signUp: function(afterSignUp){
    var instance = this;
    var adapter = this.get('store').get('defaultAdapter');
    var newUser = {
      username: this.get('username'),
      password: this.get('password'),
      email: this.get('email')
    };
    adapter.ajax(adapter.buildURL(this.constructor.typeKey), "POST", {data: newUser}).then(
      function(data){
        instance._persist(data);
        afterSignUp(data);
      },
      function(data){
        instance._persist(null);
        afterSignUp(data);
      }
    );
  },

  /**
   * Login functionality. The afterLogin callback will be called
   * with a data object that either has the login details
   * (session token, username, objectId) or the error details.
   * Error details are the same as the Parse REST API error details.
   */
  login: function(afterLogin){
    var instance = this;
    var adapter = this.get('store').get('defaultAdapter');
    var user = {
      username: this.get('username'),
      password: this.get('password')
    };
    adapter.ajax(adapter.buildURL("login"), "GET", {data: user}).then(
      function(data){
        instance._persist(data);
        afterLogin(data);
      },
      function(data){
        instance._persist(null);
        afterLogin(data);
      }
    );
  }, 

  logout: function(){
    this._persist(null);
  },

  requestPasswordReset: function(){
    var adapter = this.get('store').get('defaultAdapter');
    var user = { email: this.get('email') };
    adapter.ajax(adapter.buildURL("requestPasswordReset"), "POST", {data:user});
  },

  /**
   * Overriding the save functionality to assure that if the user object
   * is the 'current' user, then supply the session token header to allow
   * data to be saved.
   */
  save: function(){
    if(typeof(localStorage) !== undefined){
      var emberParseUser = JSON.parse(localStorage.getItem("ember_parse_user"));
      var id = this.get('id');
      var adapter = this.get('store').get('defaultAdapter');
      var headers = adapter.get('headers');
      if(id === emberParseUser.userId){
        headers["X-Parse-Session-Token"] = emberParseUser.session;
        adapter.set('headers', headers);
      }
    }
    this._super();
  }
});
