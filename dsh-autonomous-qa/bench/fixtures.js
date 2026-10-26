/** Held-out deterministic synthetic fault triggers; these labels are never given to the planners. */
export const fixtures=[
 {id:'signup',controls:[['email','email'],['age','number'],['code','number'],['nickname','text'],['agree','checkbox'],['register','button']],budget:12,
  constraints:[{when:{'#agree':'unchecked','#register':'activate'}},{when:{'#email':'empty','#code':'negative'}}],
  faults:[{id:'S1',when:{'#email':'invalid','#register':'activate'}},{id:'S2',when:{'#age':'negative','#agree':'checked'}},{id:'S3',when:{'#code':'zero','#register':'activate'}},{id:'S4',when:{'#email':'empty','#nickname':'boundary'}}]},
 {id:'checkout',controls:[['unit','number'],['quantity','number'],['discount','number'],['coupon','text'],['member','checkbox'],['checkout','button']],budget:12,
  constraints:[{when:{'#quantity':'empty','#checkout':'activate'}},{when:{'#member':'unchecked','#coupon':'boundary'}}],
  faults:[{id:'C1',when:{'#unit':'negative','#checkout':'activate'}},{id:'C2',when:{'#discount':'positive','#coupon':'boundary'}},{id:'C3',when:{'#unit':'zero','#quantity':'positive'}},{id:'C4',when:{'#member':'checked','#checkout':'activate'}}]},
 {id:'filtering',controls:[['keyword','text'],['min','number'],['max','number'],['active','checkbox'],['category','email'],['search','button']],budget:12,
  constraints:[{when:{'#min':'negative','#active':'checked'}},{when:{'#keyword':'empty','#search':'activate'}}],
  faults:[{id:'F1',when:{'#min':'positive','#max':'zero'}},{id:'F2',when:{'#keyword':'boundary','#search':'activate'}},{id:'F3',when:{'#active':'checked','#category':'invalid'}},{id:'F4',when:{'#max':'negative','#search':'activate'}}]},
 {id:'profile',controls:[['name','text'],['mail','email'],['level','number'],['verify','checkbox'],['save','button']],budget:10,
  constraints:[{when:{'#verify':'unchecked','#save':'activate'}},{when:{'#level':'negative','#mail':'invalid'}}],
  faults:[{id:'P1',when:{'#name':'boundary','#save':'activate'}},{id:'P2',when:{'#verify':'checked','#level':'zero'}},{id:'P3',when:{'#mail':'invalid','#save':'activate'}},{id:'P4',when:{'#level':'positive','#name':'empty'}}]},
 {id:'approval',controls:[['amount','number'],['region','text'],['date','email'],['urgent','checkbox'],['review','button'],['publish','button']],budget:12,
  constraints:[{when:{'#urgent':'unchecked','#publish':'activate'}},{when:{'#review':'idle','#publish':'activate'}}],
  faults:[{id:'A1',when:{'#amount':'zero','#publish':'activate'}},{id:'A2',when:{'#urgent':'checked','#review':'activate'}},{id:'A3',when:{'#region':'boundary','#publish':'activate'}},{id:'A4',when:{'#date':'invalid','#review':'activate'}}]}
];
