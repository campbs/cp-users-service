'use strict';

var _ = require('lodash');
var async = require('async');
var request = require('request');
var moment = require('moment');

module.exports = function(options){
  var seneca = this;
  var plugin = 'cd-users';
  var ENTITY_NS = 'sys/user';
  var so = seneca.options();

  seneca.add({role: 'auth', cmd: 'create_reset'}, cmd_create_reset);
  seneca.add({role: plugin, cmd: 'load'}, cmd_load);
  seneca.add({role: plugin, cmd: 'list'}, cmd_list);
  seneca.add({role: plugin, cmd: 'register'}, cmd_register);
  seneca.add({role: plugin, cmd: 'promote'}, cmd_promote);
  seneca.add({role: plugin, cmd: 'get_users_by_emails'}, cmd_get_users_by_emails);
  seneca.add({role: plugin, cmd: 'update'}, cmd_update);
  seneca.add({role: plugin, cmd: 'get_init_user_types'}, cmd_get_init_user_types);
  seneca.add({role: plugin, cmd: 'is_champion'}, cmd_is_champion);
  seneca.add({role: plugin, cmd: 'reset_password'}, cmd_reset_password);
  seneca.add({role: plugin, cmd: 'execute_reset'}, cmd_execute_reset);

  function cmd_load(args, done) {
    var seneca = this;
    var id = args.id;
    var userEntity = seneca.make(ENTITY_NS);
    
    async.waterfall([
      function(done) {
        seneca.make(ENTITY_NS).load$({id: args.id}, done);
      },
      function(user, done) {
        return done(null, user.data$());
      }
    ], done);
  }

  function cmd_list(args, done){
    var seneca = this;

    async.waterfall([
      function(done) {
        seneca.make(ENTITY_NS).list$({ids: args.ids}, done);
      },
      function(users, done) {
        return done(null, _.map(users, function (user) {
          return user.data$();
        }));
      }
    ], done);
  }

  // We create an Account in Salesforce with the champion information and we also create a Lead.
  // The user.id is used for both Account and Leads.
  function updateSalesForce(user) {
    // ideally would be done in a workqueue
    process.nextTick(function() {
      if (process.env.SALESFORCE_ENABLED !== 'true') return;

      var account = {
        PlatformId__c: user.id,
        PlatformUrl__c: 'https://zen.coderdojo.com/dashboard/profile/' + user.id,
        Email__c: user.email,
        Name: user.name,
        //RecordTypeId: "0121100000051tU" // TODO - not working
      };

      seneca.act('role:cd-salesforce,cmd:save_account', {userId: user.id, account:account}, function (err, res){
        if (err) return seneca.log.error('Error creating Account in SalesForce!', err);
        seneca.log.info('Created Account in SalesForce', account, res);

        var lead = {
          PlatformId__c: user.id,
          PlatformUrl__c: 'https://zen.coderdojo.com/dashboard/profile/' + user.id,
          Email__c: user.email,
          LastName: user.name,
          //RecordTypeId: "0121100000051tU", // TODO - not working
          Company: '<n/a>',
          "ChampionAccount__c": res.id$
        };

        seneca.act('role:cd-salesforce,cmd:save_lead', {userId: user.id, lead:lead}, function (err, res){
          if (err) return seneca.log.error('Error creating Lead in SalesForce!', err);
          seneca.log.info('Created Lead in SalesForce', account, res);
        });
      });
    });
  }

  function cmd_register(args, done) {
    var isChampion = args.isChampion === true;
    delete args.isChampion;

    //Roles Available: basic-user, mentor, champion, cdf-admin
    var seneca = this;

    if(!args['g-recaptcha-response']){
      return done(new Error('Error with captcha'));
    }

    var secret = so['recaptcha_secret_key'];
    var captchaResponse = args['g-recaptcha-response'];

    var postData = {
      url: 'https://www.google.com/recaptcha/api/siteverify',
      form: {
        response: captchaResponse,
        secret: secret
      }
    };

    function verifyCaptcha(done){
      request.post(postData, function(err, response, body){
        if(err){
          return done(err);
        }

        body = JSON.parse(body);

        if(!body.success){
          return done(JSON.stringify(body['error-codes']));
        }

        return done(null, body.success);
      });
    }

    function registerUser(success, done){
      args = _.omit(args, ['g-recaptcha-response', 'zenHostname', 'locality']);

      args.roles = ['basic-user'];
      args.mailingList = (args.mailingList) ? 1 : 0;

      seneca.act({role:'user', cmd:'register'}, args, function (err, registerResponse) {
        if(err) return done(err);
        if(!registerResponse.ok) return done(new Error(registerResponse.why));

        var user = registerResponse.user;
        //Create user profile based on initial user type.
        var userType = 'attendee-o13';
        if (user.initUserType) userType = user.initUserType.name;

        var profileData = {
          userId:user.id,
          name: user.name,
          email:user.email,
          userType: userType
        };
        seneca.act({role:'cd-profiles', cmd:'save', profile: profileData}, function (err, profile) {
          if(err) return done(err);
          if (registerResponse.ok === true && isChampion === true) updateSalesForce(registerResponse.user);
          done(null, registerResponse);
        });
      });
    }

    async.waterfall([
      verifyCaptcha,
      registerUser
    ], done);
  }

  function cmd_promote(args, done) {
    var seneca = this;
    var newRoles = args.roles;
    var userId = args.id;
    var userEntity = seneca.make$(ENTITY_NS);

    userEntity.load$(userId, function(err, response) {
      if(err) return done(err);
      var user = response;
      _.each(newRoles, function(newRole) {
        user.roles.push(newRole);
      });
      user.roles = _.uniq(user.roles);
      userEntity.save$(user, function(err, response) {
        if(err) return done(err);
        done(null, response);
      });
    });

  }

  function cmd_get_users_by_emails(args, done){
    var seneca = this, query = {};

    query.email = new RegExp(args.email, 'i');
    query.limit$ = query.limit$ ? query.limit$ : 10;

    seneca.make(ENTITY_NS).list$(query, function(err, users){
      if(err){
        return done(err);
      }

      users = _.map(users, function(user){
        return {email: user.email, id: user.id};
      });

      users = _.uniq(users, 'email');

      done(null, users);
    });
  }

  function cmd_update(args, done) {
    var seneca = this;
    var user = args.user;

    var userEntity = seneca.make(ENTITY_NS);

    userEntity.save$(user, done);
  }

  function cmd_get_init_user_types(args, done) {
    var seneca = this;
    //These types can be selected during registration on the platform.
    var initUserTypes = [
      {title: 'Parent/Guardian', name: 'parent-guardian'},
      {title: 'Mentor/Volunteer', name: 'mentor'},
      {title: 'Ninja Over 13', name: 'attendee-o13'},
      {title: 'Ninja Under 13', name: 'attendee-u13'},
      {title: 'Champion', name: 'champion'}
    ];
    done(null, initUserTypes);
  }

  /**
   * This function returns if true if a user is champion and it's dojos if any.
   */
  function cmd_is_champion(args, done){
    var seneca = this;

    seneca.make(ENTITY_NS).load$({id: args.id}, function(err, user) {
      if (err) {
        return done(err)
      }

      user = user.data$();

      var query = {
        query: {
          filtered: {
            query: {
              match_all: {}
            },
            filter: {
              bool: {
                must: [{
                  term: {userId: args.id}
                }]
              }
            }
          }
        }
      };

      seneca.act({
        role: 'cd-dojos',
        cmd: 'search',
        search: query,
        type: 'cd_dojoleads',
        user: user
      }, function (err, dojoLeads) {
        if (err) {
          return done(err)
        }

        if (dojoLeads.total > 0) {
          seneca.act({role: 'cd-dojos', cmd: 'my_dojos', user: user}, function (err, myDojos) {
            if (err) {
              return done(err)
            }

            return done(null, {
              isChampion: true,
              dojos: myDojos
            });
          });
        } else {
          return done(null, {isChampion: false});
        }
      });
    });
  }

  function cmd_reset_password(args, done) {
    var seneca = this;
    seneca.act({role: 'auth', cmd: 'create_reset'}, args, function (err, response) {
      if(err) return done(err);
      return done(null, response);
    })
  }

  function cmd_create_reset(args, done) {
    var seneca = this
    var useract = seneca.pin({role:'user',cmd:'*'});

    var nick  = args.nick || args.username;
    var email = args.email;
    var locality = args.locality || 'en_US';
    var emailCode = 'auth-create-reset-' + locality;
    var zenHostname = args.zenHostname || '127.0.0.1:8000';

    var args = {}
    if( void 0 != nick )  args.nick  = nick;
    if( void 0 != email ) args.email = email;

    useract.create_reset( args, function( err, out ) {
      if(err || !out.ok) return done(err,out);
      if(options['email-notifications'].sendemail) {
        seneca.act({role:'email-notifications', cmd:'send'}, 
          {code: emailCode,
          to: out.user.email,
          content:{name: out.user.name, resetlink: 'http://' + zenHostname + '/reset_password/' + out.reset.id, year: moment(new Date()).format('YYYY')}
        }, function (err, response) {
          if(err) return done(err);
          return done(null,{
            ok: out.ok,
          })
        });
      } else {
        return done(null, {ok: out.ok});
      }
    })
  }

  function cmd_execute_reset(args, done) {
    var resetEntity = seneca.make$('sys/reset');
    resetEntity.load$({ id: args.token }, function (err, reset) {
      if (err) { return done(err); }

      if (!reset) {
        return done(null, { ok: false, token: args.token, why: 'Reset not found.' });
      }

      if (!reset.active) {
        return done(null, { ok: false, token: args.token, why: 'Reset not active.' });
      }

      if (new Date() < new Date(reset.when) + options.resetperiod) {
        return done(null, { ok: false, token: args.token, why: 'Reset stale.' });
      }

      var userEntity = seneca.make$('sys/user');

      userEntity.load$({ id: reset.user }, function (err, user) {
        if (err) { return done(err); }
        seneca.act({ role: 'user', cmd: 'change_password', user: user, password: args.password, repeat: args.repeat }, function (err, out) {
          if (err) { return done(err); }

          out.reset = reset;
          if (!out.ok) { return done(null, out); }

          reset.active = false;
          reset.save$(function (err, reset) {
            if (err) { return done(err); }
            return done(null, { user: user, reset: reset, ok: true });
          });
        });
      });
    });
  }

  return {
    name: plugin
  };

};
