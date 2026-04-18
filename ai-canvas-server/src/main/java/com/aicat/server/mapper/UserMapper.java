package com.aicat.server.mapper;

import com.aicat.server.entity.User;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface UserMapper extends BaseMapper<User> {
    @Select("SELECT COUNT(*) FROM `user` WHERE DATE(created_at) = CURDATE()")
    long countTodayRegistered();

    @Select("SELECT COUNT(*) FROM `user` WHERE member_expire_at > NOW() AND status = 1")
    long countActiveMembers();
}
